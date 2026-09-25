import { TradeType } from '@uniswap/sdk-core';
import { ethers } from 'ethers';

import { Metric, QuoteRequest, QuoteResponse } from '../entities';
import { Context } from '../observability';
import { Quoter } from '../quoters';
import { getBestQuote } from '../quoters/best-quote';
import { ChainId } from '../util/chains';
import { NoQuotesAvailable } from '../util/errors';
import { timestampInMstoSeconds } from '../util/time';

export interface SoftQuoteResult {
  bestQuote: QuoteResponse;
  allQuotes: QuoteResponse[];
}

/**
 * The soft-quote (`POST /quote`) flow, independent of how the request arrived: fan the request out
 * to every quoter, pick the best response, and emit the flow's metrics and analytics event.
 *
 * It knows nothing about Lambda or HTTP. Callers parse and validate the request, then map the
 * result (or the thrown {@link NoQuotesAvailable}) onto their transport, so the backend monorepo
 * port can reuse this class unchanged behind its own API adapter.
 */
export class SoftQuoteBL {
  constructor(
    private readonly quoters: Quoter[],
    private readonly chainIdRpcMap: Map<ChainId, ethers.providers.StaticJsonRpcProvider>
  ) {}

  /** @throws {NoQuotesAvailable} when no quoter returned a quote. */
  public async getQuote(ctx: Context, request: QuoteRequest): Promise<SoftQuoteResult> {
    const { logger, metrics } = ctx;
    const start = Date.now();

    await metrics.count(Metric.QUOTE_REQUESTED);

    // QUOTE_LATENCY below fires only on successes (and is alarmed on), so it cannot see slow
    // no-quote outcomes, which take the full webhook fan-out just like successes. The finally makes
    // this metric cover every exit path, including the NoQuotesAvailable throw.
    try {
      const provider = this.chainIdRpcMap.get(request.tokenInChainId);

      // Analytics event line: the CloudWatch subscription filter keys on eventType, not the
      // message. The message is empty on purpose: bunyan writes `"msg":""` for a fields-only
      // call, so the record is byte-identical to the one this replaces.
      logger.info('', {
        eventType: 'QuoteRequest',
        body: {
          requestId: request.requestId,
          tokenInChainId: request.tokenInChainId,
          tokenOutChainId: request.tokenOutChainId,
          offerer: request.swapper,
          tokenIn: request.tokenIn,
          tokenOut: request.tokenOut,
          amount: request.amount.toString(),
          type: TradeType[request.type],
          createdAt: timestampInMstoSeconds(start),
          createdAtMs: start.toString(),
          numOutputs: request.numOutputs,
        },
      });

      const { bestQuote, allQuotes } = await getBestQuote(ctx, this.quoters, request, provider);
      if (!bestQuote) {
        await metrics.count(Metric.QUOTE_404);
        throw new NoQuotesAvailable();
      }

      logger.info('bestQuote', { bestQuote });

      await metrics.count(Metric.QUOTE_200);
      await metrics.timer(Metric.QUOTE_LATENCY, Date.now() - start);
      return { bestQuote, allQuotes };
    } finally {
      // Fire-and-forget: a metric failure must never replace the flow's outcome.
      void metrics.timer(Metric.QUOTE_E2E_LATENCY, Date.now() - start);
    }
  }
}
