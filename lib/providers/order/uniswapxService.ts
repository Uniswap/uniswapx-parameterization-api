import Logger from 'bunyan';

import { CosignedV2DutchOrder, CosignedV3DutchOrder, OrderType } from '@uniswap/uniswapx-sdk';
import {
  OrderServiceOrderStatus,
  OrderServiceProvider,
  OrderStatusProvider,
  PostOrderArgs,
  UniswapXServiceResponse,
} from '.';
import { ErrorResponse } from '../../handlers/base';
import { ErrorCode } from '../../util/errors';
import { FetchFn, fetchJson, HttpError, timedFetch } from '../../util/fetch-http';

// The order service validates on-chain (RPC) before accepting, so its tail can
// exceed a couple of seconds; this must stay below the hard-quote Lambda budget
// (30s) and below TAPI's hard-quote client timeout.
const ORDER_SERVICE_TIMEOUT_MS = 7000;
// Posting is processed server-side even if our request times out, so before
// reporting failure we check whether the order was actually accepted.
const ORDER_RECONCILE_DELAY_MS = 500;
const ORDER_RECONCILE_TIMEOUT_MS = 2000;

// GET /orders?orderHashes= accepts at most this many hashes per request (the service's Joi
// validator rejects longer lists with a 400). Callers batch; this client refuses to exceed it.
export const ORDER_SERVICE_MAX_ORDER_HASHES = 50;
// Per-batch ceiling for the status read. It runs in the fade cron (240s Lambda), not on a
// quote path, but a stalled order service must not eat the cron's whole budget either.
export const ORDER_STATUS_TIMEOUT_MS = 5000;

const ORDER_TYPE_MAP = new Map<Function, string>([
  [CosignedV2DutchOrder, OrderType.Dutch_V2],
  [CosignedV3DutchOrder, OrderType.Dutch_V3],
]);

// Shape of the order service's GET /dutch-auction/orders response. Reconciliation only needs
// to know whether any order matched; the fade cron reads status and fill timing per order.
interface GetOrdersResponse {
  orders?: unknown[];
}

export class UniswapXServiceProvider implements OrderServiceProvider, OrderStatusProvider {
  private log: Logger;

  constructor(_log: Logger, private uniswapxServiceUrl: string, private readonly fetchFn: FetchFn = timedFetch) {
    this.log = _log.child({ quoter: 'UniswapXOrderService' });
  }

  /**
   * Status + fill timing for a batch of order hashes (see OrderStatusProvider). The service
   * has no pagination on this endpoint, so the batch cap is the only paging there is.
   */
  async getOrdersByHashes(orderHashes: string[]): Promise<OrderServiceOrderStatus[]> {
    if (orderHashes.length === 0) {
      return [];
    }
    if (orderHashes.length > ORDER_SERVICE_MAX_ORDER_HASHES) {
      throw new Error(
        `getOrdersByHashes: ${orderHashes.length} hashes exceeds the order service cap of ${ORDER_SERVICE_MAX_ORDER_HASHES}`
      );
    }
    // Hex hashes need no encoding; the service takes them comma-joined.
    const response = await fetchJson<GetOrdersResponse>(
      this.fetchFn,
      `${this.uniswapxServiceUrl}dutch-auction/orders?orderHashes=${orderHashes.join(',')}`,
      { method: 'GET', timeoutMs: ORDER_STATUS_TIMEOUT_MS }
    );
    const orders = Array.isArray(response.data?.orders) ? response.data.orders : [];
    const statuses = orders.flatMap((order) => {
      const status = toOrderStatus(order);
      if (!status) {
        this.log.warn({ order }, 'Order service returned an order without hash/status; skipping');
      }
      return status ? [status] : [];
    });
    this.log.info({ requested: orderHashes.length, returned: statuses.length }, 'Fetched order statuses');
    return statuses;
  }

  async postOrder(args: PostOrderArgs): Promise<ErrorResponse | UniswapXServiceResponse> {
    const { order, signature, quoteId, requestId } = args;
    const orderHash = order.hash();
    this.log.info({ orderHash }, 'Posting order to UniswapX Service');

    const orderType = ORDER_TYPE_MAP.get(order.constructor);
    if (!orderType) {
      throw new Error(`Unsupported order type: ${order.constructor.name}`);
    }

    try {
      const response = await fetchJson(this.fetchFn, `${this.uniswapxServiceUrl}dutch-auction/order`, {
        method: 'POST',
        body: {
          encodedOrder: order.serialize(),
          signature: signature,
          chainId: order.chainId,
          quoteId: quoteId,
          requestId: requestId,
          orderType: orderType,
        },
        timeoutMs: ORDER_SERVICE_TIMEOUT_MS,
      });
      this.log.info({ response: response, orderHash }, 'Order posted to UniswapX Service');
      return {
        statusCode: response.status,
        data: response.data,
      };
    } catch (e) {
      if (e instanceof HttpError) {
        // No response means we timed out or the connection dropped — the order
        // service may still have accepted the order (its Lambda keeps running
        // after we hang up), so the outcome is indeterminate, not a rejection.
        // Reporting it as a failure makes clients treat a live, fillable order
        // as rejected (SWAP-2839), so reconcile before reporting.
        if (e.kind !== 'status') {
          this.log.warn({ orderHash, kind: e.kind, error: e.message }, 'Order post timed out; reconciling');
          const accepted = await this.orderExists(order.chainId, orderHash);
          if (accepted) {
            this.log.info({ orderHash }, 'Order accepted by UniswapX Service despite post timeout');
            return {
              statusCode: 201,
              data: { hash: orderHash },
            };
          }
          this.log.error({ orderHash, error: e.message }, 'Order post timed out and order was not found');
          // Status is genuinely unknown: the order may still be accepted and
          // filled. Return the hash (same { hash } shape as a success) so the
          // caller can reconcile it rather than treat the order as rejected
          // (SWAP-2839).
          return {
            statusCode: 500,
            errorCode: ErrorCode.InternalError,
            detail: 'Timed out posting order to UniswapX Service; order acceptance could not be confirmed',
            data: { hash: orderHash },
          };
        }
        this.log.error({ error: e.data, httpStatus: e.status }, 'Error posting order to UniswapX Service');
        const body = orderServiceErrorBody(e.data);
        return {
          statusCode: (e.status ?? 500) as ErrorResponse['statusCode'],
          // Passed through as the order service reported it; its codes are not all ours.
          errorCode: (body.errorCode as ErrorCode | undefined) ?? ErrorCode.InternalError,
          detail: body.detail ?? e.message,
        };
      } else {
        this.log.error({ error: e }, 'Unknown error posting order to UniswapX Service');
        return {
          statusCode: 500,
          errorCode: ErrorCode.InternalError,
          detail: 'Unknown Error posting to UniswapX Service',
        };
      }
    }
  }

  private async orderExists(chainId: number, orderHash: string): Promise<boolean> {
    try {
      // Give the order service's in-flight request a moment to persist.
      await new Promise((resolve) => setTimeout(resolve, ORDER_RECONCILE_DELAY_MS));
      const response = await fetchJson<GetOrdersResponse>(
        this.fetchFn,
        `${this.uniswapxServiceUrl}dutch-auction/orders?chainId=${chainId}&orderHash=${orderHash}`,
        { method: 'GET', timeoutMs: ORDER_RECONCILE_TIMEOUT_MS }
      );
      return Array.isArray(response.data?.orders) && response.data.orders.length > 0;
    } catch (e) {
      this.log.error({ orderHash, error: e instanceof Error ? e.message : e }, 'Failed to reconcile order post');
      return false;
    }
  }
}

// The order service's error body is `{ errorCode, detail }`; anything else yields neither.
function orderServiceErrorBody(data: unknown): { errorCode?: string; detail?: string } {
  if (typeof data !== 'object' || data === null) {
    return {};
  }
  const { errorCode, detail } = data as Record<string, unknown>;
  return {
    ...(typeof errorCode === 'string' && { errorCode }),
    ...(typeof detail === 'string' && { detail }),
  };
}

// One GET /orders item reduced to the breaker's view. Anything without a hash and status is
// dropped (the caller treats a missing order as "not found" and retries next run).
function toOrderStatus(order: unknown): OrderServiceOrderStatus | undefined {
  if (typeof order !== 'object' || order === null) {
    return undefined;
  }
  const { orderHash, orderStatus, fillBlock, fillTimestamp } = order as Record<string, unknown>;
  if (typeof orderHash !== 'string' || typeof orderStatus !== 'string') {
    return undefined;
  }
  return {
    orderHash: orderHash.toLowerCase(),
    orderStatus,
    ...(typeof fillBlock === 'number' && { fillBlock }),
    ...(typeof fillTimestamp === 'number' && { fillTimestamp }),
  };
}
