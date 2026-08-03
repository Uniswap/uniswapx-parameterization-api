import { TradeType } from '@uniswap/sdk-core';
import { MetricLoggerUnit } from '@uniswap/smart-order-router';
import Joi from 'joi';

import { Metric, QuoteRequest } from '../../entities';
import { getBestQuote } from '../../quoters/best-quote';
import { NoQuotesAvailable } from '../../util/errors';
import { timestampInMstoSeconds } from '../../util/time';
import { APIGLambdaHandler } from '../base';
import { APIHandleRequestParams, ErrorResponse, Response } from '../base/api-handler';
import { ContainerInjected, RequestInjected } from './injector';
import {
  PostQuoteRequestBody,
  PostQuoteRequestBodyJoi,
  PostQuoteResponseWithAllQuotes,
  PostQuoteResponseWithAllQuotesJoi,
} from './schema';

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
    return PostQuoteResponseWithAllQuotesJoi;
  }
}
