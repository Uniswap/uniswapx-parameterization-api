import Joi from 'joi';

import { ErrorCode } from '../../util/errors';
import { APIGLambdaHandler } from '../base';
import { APIHandleRequestParams, ErrorResponse, Response } from '../base/api-handler';
import { ContainerInjected, RequestInjected } from './injector';
import {
  SynthSwitchQueryParams,
  SynthSwitchQueryParamsJoi,
  SynthSwitchResponse,
  SynthSwitchResponseJoi,
} from './schema';

export class SwitchHandler extends APIGLambdaHandler<
  ContainerInjected,
  RequestInjected,
  void,
  SynthSwitchQueryParams,
  SynthSwitchResponse
> {
  public async handleRequest(
    params: APIHandleRequestParams<ContainerInjected, RequestInjected, void, SynthSwitchQueryParams>
  ): Promise<ErrorResponse | Response<SynthSwitchResponse>> {
    const {
      requestInjected: { log, inputToken, outputToken, inputTokenChainId, outputTokenChainId, amount, type },
      containerInjected: { dbInterface },
    } = params;

    let enabled: boolean;
    try {
      enabled = await dbInterface.syntheticQuoteForTradeEnabled({
        tokenIn: inputToken,
        tokenInChainId: inputTokenChainId,
        tokenOut: outputToken,
        tokenOutChainId: outputTokenChainId,
        type,
        amount,
      });
      return {
        statusCode: 200,
        body: { enabled },
      };
    } catch (e) {
      log.error({ err: e }, 'error querying synthSwitch dynamo table');
      return {
        statusCode: 500,
        errorCode: ErrorCode.InternalError,
        detail: 'DynamoDB Error',
      };
    }
  }

  protected requestBodySchema(): Joi.ObjectSchema | null {
    return null;
  }

  protected requestQueryParamsSchema(): Joi.ObjectSchema | null {
    return SynthSwitchQueryParamsJoi;
  }

  protected responseBodySchema(): Joi.ObjectSchema | null {
    return SynthSwitchResponseJoi;
  }
}
