import { TradeType } from '@uniswap/sdk-core';
import { ethers } from 'ethers';

import { Quoter } from '.';
import { Metric, QuoteRequest, QuoteResponse } from '../entities';
import { Context } from '../observability';

export type EventType = 'QuoteResponse' | 'HardResponse';

export interface BestQuoteResult {
  bestQuote: QuoteResponse | null;
  allQuotes: QuoteResponse[];
}

// fetch quotes from all quoters and return the best one along with all quotes
export async function getBestQuote(
  ctx: Context,
  quoters: Quoter[],
  quoteRequest: QuoteRequest,
  provider?: ethers.providers.StaticJsonRpcProvider,
  eventType: EventType = 'QuoteResponse'
): Promise<BestQuoteResult> {
  const responses: QuoteResponse[] = (
    await Promise.all(quoters.map((q) => q.quote(ctx, quoteRequest, provider)))
  ).flat();
  switch (responses.length) {
    case 0:
      await ctx.metrics.count(Metric.RFQ_COUNT_0);
      break;
    case 1:
      await ctx.metrics.count(Metric.RFQ_COUNT_1);
      break;
    case 2:
      await ctx.metrics.count(Metric.RFQ_COUNT_2);
      break;
    case 3:
      await ctx.metrics.count(Metric.RFQ_COUNT_3);
      break;
    default:
      await ctx.metrics.count(Metric.RFQ_COUNT_4_PLUS);
      break;
  }

  // return the response with the highest amountOut value
  const bestQuote = responses.reduce((best: QuoteResponse | null, quote: QuoteResponse) => {
    // Analytics event line: the CloudWatch subscription filter keys on eventType, not the message,
    // and an empty message writes the same record bunyan writes for a fields-only call.
    ctx.logger.info('', {
      eventType: eventType,
      body: { ...quote.toLog(), offerer: quote.swapper, endpoint: quote.endpoint, fillerName: quote.fillerName },
    });

    if (
      !best ||
      (quoteRequest.type == TradeType.EXACT_INPUT && quote.amountOut.gt(best.amountOut)) ||
      (quoteRequest.type == TradeType.EXACT_OUTPUT && quote.amountIn.lt(best.amountIn))
    ) {
      return quote;
    }
    return best;
  }, null);

  return { bestQuote, allQuotes: responses };
}
