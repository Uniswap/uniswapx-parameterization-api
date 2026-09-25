import Joi from 'joi';

import { APIGLambdaHandler } from '../base';
import { APIHandleRequestParams, ErrorResponse, Response } from '../base/api-handler';
import { ContainerInjected, RequestInjected } from './injector';
import {
  HardQuoteRequestBody,
  HardQuoteRequestBodyJoi,
  HardQuoteResponseData,
  HardQuoteResponseDataJoi,
} from './schema';

/**
 * Lambda adapter for `POST /hard-quote`: validates the body (via the schemas below), runs
 * {@link HardQuoteBL}, and maps its outcome to a status code. Thrown CustomErrors (no quotes,
 * unknown cosigner, deadline too close, a failed post) are mapped to their bodies by the base
 * handler.
 */
export class QuoteHandler extends APIGLambdaHandler<
  ContainerInjected,
  RequestInjected,
  HardQuoteRequestBody,
  void,
  HardQuoteResponseData
> {
  public async handleRequest(
    params: APIHandleRequestParams<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>
  ): Promise<ErrorResponse | Response<HardQuoteResponseData>> {
    const {
      requestInjected: { ctx },
      containerInjected: { hardQuote },
      requestBody,
    } = params;

    const outcome = await hardQuote.getHardQuote(ctx, requestBody);
    switch (outcome.kind) {
      case 'posted':
        return { statusCode: 200, body: outcome.body };
      // Only a 4xx from the order service is a genuine rejection of the order. Anything else
      // (timeouts, 5xx) is indeterminate: the order service may have accepted the order after we
      // stopped waiting, and rewriting it to 400 makes clients treat a live, fillable order as
      // rejected.
      case 'rejected':
        return { ...outcome.error, statusCode: 400 };
      case 'indeterminate':
        return { ...outcome.error, statusCode: 500 };
    }
  }

  protected requestBodySchema(): Joi.ObjectSchema | null {
    return HardQuoteRequestBodyJoi;
  }

  protected requestQueryParamsSchema(): Joi.ObjectSchema | null {
    return null;
  }

  protected responseBodySchema(): Joi.ObjectSchema | null {
    return HardQuoteResponseDataJoi;
  }
}
