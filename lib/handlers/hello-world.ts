import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as bunyan, default as Logger } from 'bunyan';
import Joi from 'joi';

import { APIGLambdaHandler } from './base';
import { APIHandleRequestParams, ApiInjector, ApiRInj, ErrorResponse, Response } from './base/api-handler';

export class HelloWorldInjector extends ApiInjector<string, ApiRInj, void, void> {
  public async buildContainerInjected(): Promise<string> {
    return 'hello world';
  }

  public async getRequestInjected(
    containerInjected: string,
    _requestBody: void,
    //@ts-ignore
    requestQueryParams: void,
    _event: APIGatewayProxyEvent,
    context: Context,
    log: Logger
  ): Promise<ApiRInj> {
    const requestId = context.awsRequestId;

    log = log.child({
      serializers: bunyan.stdSerializers,
      containerInjected: containerInjected,
      requestId,
    });

    return {
      log,
      requestId,
    };
  }
}

export class HelloWorldHandler extends APIGLambdaHandler<string, ApiRInj, void, void, string> {
  public async handleRequest(
    params: APIHandleRequestParams<string, ApiRInj, void, void>
  ): Promise<ErrorResponse | Response<string>> {
    const {
      requestInjected: { log, requestId },
    } = params;

    log.info(`hello from ${requestId}`);
    return {
      statusCode: 200,
      body: 'hello world',
    };
  }

  protected requestBodySchema(): Joi.ObjectSchema | null {
    return null;
  }

  protected requestQueryParamsSchema(): Joi.ObjectSchema | null {
    return null;
  }

  protected responseBodySchema(): Joi.ObjectSchema | null {
    return null;
  }
}
