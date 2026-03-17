import { TradeType } from '@uniswap/sdk-core';
import { IMetric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import Logger from 'bunyan';
import Joi from 'joi';
import { ethers } from 'ethers';

import { Metric, QuoteRequest, QuoteResponse } from '../../entities';
import { Quoter } from '../../quoters';
import { NoQuotesAvailable } from '../../util/errors';
import { timestampInMstoSeconds } from '../../util/time';
import { APIGLambdaHandler } from '../base';
import { APIHandleRequestParams, ErrorResponse, Response } from '../base/api-handler';
import { ContainerInjected, RequestInjected } from './injector';
import {
  PostQuoteRequestBody,
  PostQuoteRequestBodyJoi,
  PostQuoteResponseWithAllQuotes,
  URAResponseJoi,
} from './schema';

export type EventType = 'QuoteResponse' | 'HardResponse';

export interface BestQuoteResult {
  bestQuote: QuoteResponse | null;
  allQuotes: QuoteResponse[];
}

export class QuoteHandler extends APIGLambdaHandler<
  ContainerInjected,
  RequestInjected,
  PostQuoteRequestBody,
  void,
  PostQuoteResponseWithAllQuotes
> {
  public async handleRequest(
    params: APIHandleRequestParams<ContainerInjected, RequestInjected, PostQuoteRequestBody, void>
  ): Promise<ErrorResponse | Response<PostQuoteResponseWithAllQuotes>> {
    const {
      requestInjected: { log, metric },
      requestBody,
      containerInjected: { quoters, chainIdRpcMap },
    } = params;
    const start = Date.now();

    metric.putMetric(Metric.QUOTE_REQUESTED, 1, MetricLoggerUnit.Count);

    const provider = chainIdRpcMap.get(requestBody.tokenInChainId);

    const request = QuoteRequest.fromRequestBody(requestBody);
    log.info({
      eventType: 'QuoteRequest',
      body: {
        requestId: request.requestId,
        tokenInChainId: request.tokenInChainId,
        tokenOutChainId: request.tokenInChainId,
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

    const { bestQuote, allQuotes } = await getBestQuote(quoters, request, log, metric, provider);
    if (!bestQuote) {
      metric.putMetric(Metric.QUOTE_404, 1, MetricLoggerUnit.Count);
      throw new NoQuotesAvailable();
    }

    log.info({ bestQuote: bestQuote }, 'bestQuote');

    metric.putMetric(Metric.QUOTE_200, 1, MetricLoggerUnit.Count);
    metric.putMetric(Metric.QUOTE_LATENCY, Date.now() - start, MetricLoggerUnit.Milliseconds);
    return {
      statusCode: 200,
      body: {
        ...bestQuote.toResponseJSON(),
        allQuotes: allQuotes.map((q) => q.toResponseJSON()),
      },
    };
  }

  protected requestBodySchema(): Joi.ObjectSchema | null {
    return PostQuoteRequestBodyJoi;
  }

  protected requestQueryParamsSchema(): Joi.ObjectSchema | null {
    return null;
  }

  protected responseBodySchema(): Joi.ObjectSchema | null {
    return URAResponseJoi;
  }
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
