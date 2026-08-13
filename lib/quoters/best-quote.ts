import { TradeType } from '@uniswap/sdk-core';
import { IMetric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import Logger from 'bunyan';
import { ethers } from 'ethers';

import { Quoter } from '.';
import { Metric, QuoteRequest, QuoteResponse } from '../entities';

export type EventType = 'QuoteResponse' | 'HardResponse';

export interface BestQuoteResult {
  bestQuote: QuoteResponse | null;
  allQuotes: QuoteResponse[];
}

// fetch quotes from all quoters and return the best one along with all quotes
export async function getBestQuote(
  quoters: Quoter[],
  quoteRequest: QuoteRequest,
  log: Logger,
  metric: IMetric,
  provider?: ethers.providers.StaticJsonRpcProvider,
  eventType: EventType = 'QuoteResponse'
): Promise<BestQuoteResult> {
  const responses: QuoteResponse[] = (await Promise.all(quoters.map((q) => q.quote(quoteRequest, provider)))).flat();
  switch (responses.length) {
    case 0:
      metric.putMetric(Metric.RFQ_COUNT_0, 1, MetricLoggerUnit.Count);
      break;
    case 1:
      metric.putMetric(Metric.RFQ_COUNT_1, 1, MetricLoggerUnit.Count);
      break;
    case 2:
      metric.putMetric(Metric.RFQ_COUNT_2, 1, MetricLoggerUnit.Count);
      break;
    case 3:
      metric.putMetric(Metric.RFQ_COUNT_3, 1, MetricLoggerUnit.Count);
      break;
    default:
      metric.putMetric(Metric.RFQ_COUNT_4_PLUS, 1, MetricLoggerUnit.Count);
      break;
  }

  // return the response with the highest amountOut value
  const bestQuote = responses.reduce((best: QuoteResponse | null, quote: QuoteResponse) => {
    log.info({
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
