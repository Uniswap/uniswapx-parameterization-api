import { TradeType } from '@uniswap/sdk-core';
import { IMetric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import Logger from 'bunyan';
import Joi from 'joi';

import { Metric, QuoteRequest, QuoteResponse } from '../../entities';
import { Quoter } from '../../quoters';
import { currentTimestampInSeconds } from '../../util/time';
import { APIGLambdaHandler } from '../base';
import { APIHandleRequestParams, ErrorResponse, Response } from '../base/api-handler';
import { ContainerInjected, RequestInjected } from './injector';
import { PostQuoteRequestBody, PostQuoteRequestBodyJoi, PostQuoteResponse, URAResponseJoi } from './schema';

export class QuoteHandler extends APIGLambdaHandler<
  ContainerInjected,
  RequestInjected,
  PostQuoteRequestBody,
  void,
  PostQuoteResponse
> {
  public async handleRequest(
    params: APIHandleRequestParams<ContainerInjected, RequestInjected, PostQuoteRequestBody, void>
  ): Promise<ErrorResponse | Response<PostQuoteResponse>> {
    const {
      requestInjected: { log, metric },
      requestBody,
      containerInjected: { quoters },
    } = params;
    const before = Date.now();

    metric.putMetric(Metric.QUOTE_REQUESTED, 1, MetricLoggerUnit.Count);

    const request = QuoteRequest.fromRequestBody(requestBody);
    log.info({
      eventType: 'QuoteRequest',
      body: {
        requestId: request.requestId,
        tokenInChainId: request.tokenInChainId,
        tokenOutChainId: request.tokenInChainId,
        offerer: request.offerer,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amount: request.amount.toString(),
        type: TradeType[request.type],
        createdAt: currentTimestampInSeconds(),
      },
    });

    const bestQuote = await getBestQuote(quoters, request, log, metric);
    if (!bestQuote) {
      metric.putMetric(Metric.QUOTE_404, 1, MetricLoggerUnit.Count);
      return {
        statusCode: 404,
        detail: 'No quotes available',
        errorCode: 'QUOTE_ERROR',
      };
    }

    log.info({ bestQuote: bestQuote }, 'bestQuote');

    metric.putMetric(Metric.QUOTE_200, 1, MetricLoggerUnit.Count);
    metric.putMetric(Metric.QUOTE_LATENCY, Date.now() - before, MetricLoggerUnit.Milliseconds);
    return {
      statusCode: 200,
      body: bestQuote.toResponseJSON(),
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

// fetch quotes from all quoters and return the best one
async function getBestQuote(
  quoters: Quoter[],
  quoteRequest: QuoteRequest,
  log: Logger,
  metric: IMetric
): Promise<QuoteResponse | null> {
  const responses: QuoteResponse[] = (await Promise.all(quoters.map((q) => q.quote(quoteRequest)))).flat();
  metric.putMetric(Metric.QUOTE_RESPONSE_COUNT, responses.length, MetricLoggerUnit.Count);

  // return the response with the highest amountOut value
  return responses.reduce((bestQuote: QuoteResponse | null, quote: QuoteResponse) => {
    log.info({
      eventType: 'QuoteResponse',
      body: quote.toLog(),
    });

    if (!bestQuote || quote.amountOut.gt(bestQuote.amountOut)) {
      return quote;
    }
    return bestQuote;
  }, null);
}
