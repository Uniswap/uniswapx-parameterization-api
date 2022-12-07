import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as bunyan, default as Logger } from 'bunyan';

import { ApiInjector, ApiRInj } from '../base/api-handler';
import { PostQuoteRequestBody } from './schema';

export interface ContainerInjected {}

export class QuoteInjector extends ApiInjector<ContainerInjected, ApiRInj, PostQuoteRequestBody, void> {
  public async buildContainerInjected(): Promise<ContainerInjected> {
    return {};
  }

  public async getRequestInjected(
    containerInjected: ContainerInjected,
    requestBody: PostQuoteRequestBody,
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
      ...requestBody,
    };
  }
}
