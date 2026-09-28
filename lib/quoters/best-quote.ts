import { TradeType } from '@uniswap/sdk-core';
import { ethers } from 'ethers';

import { Quoter } from '.';
import { Metric, QuoteRequest, QuoteResponse } from '../entities';
import { Context } from '../observability';
import { LOG_LINE_QUOTE_ANALYTICS, QuoteAnalytics } from '../providers/analytics/quote-analytics';

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
  eventType: EventType = 'QuoteResponse',
  analytics: QuoteAnalytics = LOG_LINE_QUOTE_ANALYTICS
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
    // The log-line form keys on eventType for the CloudWatch subscription filter, and an empty
    // message writes the same record bunyan writes for a fields-only call.
    analytics.record(
      eventType,
      { ...quote.toLog(), offerer: quote.swapper, endpoint: quote.endpoint, fillerName: quote.fillerName },
      (fields) => ctx.logger.info('', fields)
    );

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
