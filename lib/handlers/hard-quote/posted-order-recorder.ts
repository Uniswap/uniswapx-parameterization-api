import { IMetric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import { CosignedV2DutchOrder, CosignedV3DutchOrder, OrderType } from '@uniswap/uniswapx-sdk';
import Logger from 'bunyan';
import { ethers } from 'ethers';
import { getAddress } from 'ethers/lib/utils';

import { Metric } from '../../entities/aws-metrics-logger';
import { QuoteResponse } from '../../entities/QuoteResponse';
import { FillerAddressRepository } from '../../repositories/filler-address-repository';
import {
  PostedOrderOutcome,
  PostedOrderRecord,
  PostedOrderRepository,
} from '../../repositories/posted-order-repository';
import { withTimeout } from '../../util/time';

// Hard wall on the bookkeeping writes. They sit in series with the hard-quote response (the
// Lambda freezes once the handler returns, so a write cannot be fire-and-forget), and the
// order-service post before them already spends up to ~9.5s, so this is the ceiling on what a
// misbehaving DynamoDB may add to a quote. The two writes run concurrently under one wall; a
// warm in-region PutItem/UpdateItem is single-digit ms.
export const POSTED_ORDER_WRITE_TIMEOUT_MS = 500;

export type CosignedOrder = CosignedV2DutchOrder | CosignedV3DutchOrder;

export interface RecordPostedOrderArgs {
  repository: PostedOrderRepository;
  // Address -> webhook attribution for the fade breaker's legacy (Redshift) path, which sees
  // only the address. Written alongside the PostedOrders row from the same record.
  fillerAddressRepository: FillerAddressRepository;
  order: CosignedOrder;
  // The winning RFQ quote, or undefined for an open order. Only RFQ-won orders are recorded.
  quote: QuoteResponse | undefined;
  // The quoteId actually sent to the order service (may differ from quote.quoteId only when
  // there was no quote, in which case nothing is recorded anyway).
  quoteId: string;
  requestId: string;
  log: Logger;
  metric: IMetric;
  timeoutMs?: number;
}

export type BuildPostedOrderRecordArgs = Pick<RecordPostedOrderArgs, 'order' | 'quoteId' | 'requestId'> & {
  quote: QuoteResponse;
  postedAtMs: number;
};

/**
 * Whether the cosigned order grants exclusivity to a filler. Open orders and quotes that
 * did not beat the swapper's own price are cosigned with the zero address; the breaker's
 * fade definition (`po.filler != 0x0`) excludes those, so they are not recorded either.
 */
export function exclusiveFillerOf(order: CosignedOrder): string | undefined {
  const filler = order.info.cosignerData.exclusiveFiller;
  return filler === ethers.constants.AddressZero ? undefined : getAddress(filler);
}

/**
 * Builds the row for a confirmed post. Pure: everything comes from the cosigned order (the
 * source of truth for what was posted) and the winning quote (the filler identity).
 */
export function buildPostedOrderRecord(args: BuildPostedOrderRecordArgs): PostedOrderRecord {
  const { order, quote, quoteId, requestId, postedAtMs } = args;
  const fillerAddress = exclusiveFillerOf(order);
  if (!fillerAddress) {
    throw new Error('buildPostedOrderRecord called for an order with no exclusive filler');
  }

  const decayStart =
    order instanceof CosignedV2DutchOrder
      ? { orderType: OrderType.Dutch_V2, decayStartTime: order.info.cosignerData.decayStartTime }
      : { orderType: OrderType.Dutch_V3, decayStartBlock: order.info.cosignerData.decayStartBlock };

  return {
    orderHash: order.hash(),
    quoteId,
    requestId,
    chainId: order.chainId,
    fillerAddress,
    // QuoteResponse.endpoint is the RFQ webhook the quote came from — the same string
    // recordPostedOrder attributes fillerAddress to in FillerAddress and the breaker keys
    // FillerCBTimestampsV2 by, so no lookup is needed to resolve it.
    filler: quote.endpoint,
    fillerName: quote.fillerName,
    ...decayStart,
    deadline: order.info.deadline,
    tokenIn: getAddress(order.info.input.token),
    tokenOut: getAddress(order.info.outputs[0].token),
    postedAt: Math.floor(postedAtMs / 1000),
    outcome: PostedOrderOutcome.PENDING,
  };
}

/**
 * Records a confirmed RFQ-won post: the PostedOrders row and, from the same record, the
 * FillerAddress attribution (fillerAddress -> filler endpoint). Never throws and never takes
 * longer than `timeoutMs`: both rows are derived bookkeeping, and losing one is strictly
 * better than failing or slowing a quote the order service has already accepted. Every
 * failure (including the timeout) is logged and counted per row; the caller does not need
 * to inspect the result.
 */
export async function recordPostedOrder(args: RecordPostedOrderArgs): Promise<void> {
  const { repository, fillerAddressRepository, order, quote, quoteId, requestId, log, metric } = args;
  const timeoutMs = args.timeoutMs ?? POSTED_ORDER_WRITE_TIMEOUT_MS;

  if (!quote || !exclusiveFillerOf(order)) {
    return;
  }

  const start = Date.now();
  let orderHash: string | undefined;
  try {
    const record = buildPostedOrderRecord({ order, quote, quoteId, requestId, postedAtMs: start });
    orderHash = record.orderHash;
    // Both rows state the same fact (this address, quoting for this webhook, is on this order),
    // so they are written from one record, concurrently — the response pays the slower write,
    // not the sum — and each under the same wall. Neither outcome affects the other.
    const [posted, attributed] = await Promise.allSettled([
      withTimeout(repository.putPostedOrder(record), timeoutMs, 'posted-order'),
      withTimeout(
        fillerAddressRepository.recordWinningAddress(record.fillerAddress, record.filler),
        timeoutMs,
        'filler-address'
      ),
    ]);
    if (posted.status === 'fulfilled') {
      metric.putMetric(Metric.POSTED_ORDER_RECORDED, 1, MetricLoggerUnit.Count);
      log.info({ orderHash, filler: record.filler, fillerAddress: record.fillerAddress }, 'Recorded posted order');
    } else {
      metric.putMetric(Metric.POSTED_ORDER_RECORD_FAILED, 1, MetricLoggerUnit.Count);
      log.error({ orderHash, error: errorMessage(posted.reason) }, 'Failed to record posted order');
    }
    if (attributed.status === 'rejected') {
      metric.putMetric(Metric.FILLER_ADDRESS_RECORD_FAILED, 1, MetricLoggerUnit.Count);
      log.warn(
        {
          orderHash,
          filler: record.filler,
          fillerAddress: record.fillerAddress,
          error: errorMessage(attributed.reason),
        },
        'Failed to record filler address; order unaffected, attribution skipped'
      );
    } else if (attributed.value.outcome === 'owned_by_other') {
      // The write itself succeeded in reaching DynamoDB; the address stays with its first
      // owner, so this filler's fades on it bench nobody until that row expires or is deleted.
      metric.putMetric(Metric.FILLER_ADDRESS_CLAIM_REJECTED, 1, MetricLoggerUnit.Count);
      log.warn(
        {
          orderHash,
          filler: record.filler,
          fillerAddress: record.fillerAddress,
          existingOwner: attributed.value.existingOwner,
        },
        'Filler address already attributed to another endpoint; claim refused, order unaffected'
      );
    }
  } catch (e) {
    // Only buildPostedOrderRecord can throw here; the writes are settled above.
    metric.putMetric(Metric.POSTED_ORDER_RECORD_FAILED, 1, MetricLoggerUnit.Count);
    log.error({ orderHash, error: errorMessage(e) }, 'Failed to record posted order');
  } finally {
    metric.putMetric(Metric.POSTED_ORDER_RECORD_LATENCY, Date.now() - start, MetricLoggerUnit.Milliseconds);
  }
}

const errorMessage = (e: unknown): unknown => (e instanceof Error ? e.message : e);
