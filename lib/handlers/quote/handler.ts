import { TradeType } from '@uniswap/sdk-core';
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
      requestInjected: { ctx, log, metric },
      requestBody,
      containerInjected: { quoters, chainIdRpcMap },
    } = params;
    const { logger, metrics } = ctx;
    const start = Date.now();

    metrics.increment(Metric.QUOTE_REQUESTED);

    // QUOTE_LATENCY below fires only on 200s (and is alarmed on), so it cannot see slow
    // 404s — which take the full webhook fan-out just like successes. The finally makes
    // this metric cover every exit path, including the NoQuotesAvailable throw.
    try {
      const provider = chainIdRpcMap.get(requestBody.tokenInChainId);

      const request = QuoteRequest.fromRequestBody(requestBody);
      logger.info({
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

      // The quote path below the handler still takes the bunyan logger and the
      // smart-order-router IMetric positionally (moved to ctx in a later PR); both are the
      // same objects ctx wraps, so its logs and metrics are unchanged.
      const { bestQuote, allQuotes } = await getBestQuote(quoters, request, log, metric, provider);
      if (!bestQuote) {
        metrics.increment(Metric.QUOTE_404);
        throw new NoQuotesAvailable();
      }

      logger.info({ bestQuote: bestQuote }, 'bestQuote');

      metrics.increment(Metric.QUOTE_200);
      metrics.histogram(Metric.QUOTE_LATENCY, Date.now() - start);
      return {
        statusCode: 200,
        body: {
          ...bestQuote.toResponseJSON(),
          allQuotes: allQuotes.map((q) => q.toResponseJSON()),
        },
      };
    } finally {
      metrics.histogram(Metric.QUOTE_E2E_LATENCY, Date.now() - start);
    }
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
