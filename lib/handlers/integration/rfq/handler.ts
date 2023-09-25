import { TradeType } from '@uniswap/sdk-core';
import { ethers } from 'ethers';
import Joi from 'joi';

import { QuoteRequest } from '../../../entities';
import { APIGLambdaHandler, APIHandleRequestParams, ApiRInj, ErrorResponse, Response } from '../../base/api-handler';
import {
  PostQuoteRequestBody,
  PostQuoteRequestBodyJoi,
  PostQuoteResponse,
  PostQuoteResponseJoi,
} from '../../quote/schema';
import { ContainerInjected } from './injector';

export class RfqHandler extends APIGLambdaHandler<
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
    } = params;

    const request = QuoteRequest.fromRequestBody(requestBody);

    log.info({ request: request }, 'rfq request received');
    return {
      statusCode: 200,
      body: {
        chainId: request.tokenInChainId,
        requestId: request.requestId,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.type === TradeType.EXACT_INPUT ? request.amount.toString() : '1',
        amountOut: request.type === TradeType.EXACT_OUTPUT ? request.amount.toString() : '1',
        swapper: request.swapper,
        filler: ethers.constants.AddressZero,
        quoteId: request.quoteId,
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
