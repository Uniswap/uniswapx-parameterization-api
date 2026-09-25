import Joi from 'joi';

import { QuoteRequest } from '../../entities';
import { APIGLambdaHandler } from '../base';
import { APIHandleRequestParams, ErrorResponse, Response } from '../base/api-handler';
import { ContainerInjected, RequestInjected } from './injector';
import {
  PostQuoteRequestBody,
  PostQuoteRequestBodyJoi,
  PostQuoteResponseWithAllQuotes,
  PostQuoteResponseWithAllQuotesJoi,
} from './schema';

/**
 * Lambda adapter for `POST /quote`: validates the body (via the schemas below), hands the parsed
 * request to {@link SoftQuoteBL}, and shapes its result into the response body. A thrown
 * NoQuotesAvailable is mapped to its 404 body by the base handler.
 */
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
      requestInjected: { ctx },
      requestBody,
      containerInjected: { softQuote },
    } = params;

    const { bestQuote, allQuotes } = await softQuote.getQuote(ctx, QuoteRequest.fromRequestBody(requestBody));
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
