import Joi from 'joi';

import { QuoteRequest, QuoteResponse } from '../../entities';
import { Quoter } from '../../quoters';
import { APIGLambdaHandler } from '../base';
import { APIHandleRequestParams, ApiRInj, ErrorResponse, Response } from '../base/api-handler';
import { ContainerInjected } from './injector';
import { PostQuoteRequestBody, PostQuoteRequestBodyJoi, PostQuoteResponse, PostQuoteResponseJoi } from './schema';

export class QuoteHandler extends APIGLambdaHandler<
  ContainerInjected,
  ApiRInj,
  PostQuoteRequestBody,
  void,
  PostQuoteResponse
> {
  public async handleRequest(
    params: APIHandleRequestParams<ContainerInjected, ApiRInj, PostQuoteRequestBody, void>
  ): Promise<ErrorResponse | Response<PostQuoteResponse>> {
    const {
      requestInjected: { log },
      requestBody,
      containerInjected: { quoters },
    } = params;

    // TODO: add quoter filtering based on request param, i.e. user can request only RFQ or only ROUTER
    const request = QuoteRequest.fromRequestBody(requestBody);
    const bestQuote = await getBestQuote(quoters, request);
    if (!bestQuote) {
      return {
        statusCode: 404,
        detail: 'No quotes available',
        errorCode: 'QUOTE_ERROR',
      };
    }

    log.info(`Quoted requestId: ${request.requestId}: ${bestQuote.amountOut.toString()}`);
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
        type: request.type,
      },
    });

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
    return PostQuoteResponseJoi;
  }
}

// fetch quotes from all quoters and return the best one
async function getBestQuote(quoters: Quoter[], quoteRequest: QuoteRequest): Promise<QuoteResponse | null> {
  const responses: QuoteResponse[] = (await Promise.all(quoters.map((q) => q.quote(quoteRequest)))).flat();

  // return the response with the highest amountOut value
  return responses.reduce((bestQuote: QuoteResponse | null, quote: QuoteResponse) => {
    if (!bestQuote || quote.amountOut.gt(bestQuote.amountOut)) {
      return quote;
    }
    return bestQuote;
  }, null);
}
