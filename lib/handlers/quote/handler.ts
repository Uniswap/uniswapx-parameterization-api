import { BigNumber } from 'ethers';
import Joi from 'joi';

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
    params: APIHandleRequestParams<string, ApiRInj, PostQuoteRequestBody, void>
  ): Promise<ErrorResponse | Response<PostQuoteResponse>> {
    const {
      requestInjected: { log, requestId },
      requestBody: { tokenIn, tokenOut, amountIn },
    } = params;

    log.info(`hello from ${requestId}`);
    return {
      statusCode: 200,
      body: {
        requestId: 'fake request id',
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: BigNumber.from('1324'),
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
    return PostQuoteResponseJoi;
  }
}
