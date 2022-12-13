import Joi from 'joi';

import { APIGLambdaHandler } from '../base';
import { APIHandleRequestParams, ApiRInj, ErrorResponse, Response } from '../base/api-handler';
import { ContainerInjected } from './injector';
import { Quoter } from '../../quoters';
import { QuoteRequest, QuoteResponse } from '../../entities';
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
      requestInjected: { log, requestId },
      requestBody,
      containerInjected: { quoters },
    } = params;

    const bestQuote = await getBestQuote(quoters, QuoteRequest.fromRequestBody(requestBody));
    if (!bestQuote) {
      return {
        statusCode: 400,
        detail: 'No quotes available',
        errorCode: 'QUOTE_ERROR',
      };
    }

    log.info(`hello from ${requestId}`);
    return {
      statusCode: 200,
      body: bestQuote.toResponse(),
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
  const responses = await Promise.all(quoters.map((q) => q.quote(quoteRequest)));
  for (const response of responses) {
    if (response) {
      return response;
    }
  }

  return null;
}
