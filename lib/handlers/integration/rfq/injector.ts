import { setGlobalLogger } from '@uniswap/smart-order-router';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as bunyan, default as Logger } from 'bunyan';

import { ApiInjector, ApiRInj } from '../../base';
import * as schema from '../../quote/schema';

export interface ContainerInjected {}

export class RfqInjector extends ApiInjector<ContainerInjected, ApiRInj, schema.PostQuoteRequestBody, void> {
  public async buildContainerInjected(): Promise<ContainerInjected> {
    return {};
  }

  public async getRequestInjected(
    _containerInjected: ContainerInjected,
    requestBody: schema.PostQuoteRequestBody,
    _requestQueryParams: void,
    _event: APIGatewayProxyEvent,
    context: Context,
    log: Logger
  ): Promise<ApiRInj> {
    const requestId = context.awsRequestId;

    log = log.child({
      serializers: bunyan.stdSerializers,
      requestBody,
      requestId,
    });
    setGlobalLogger(log);

    return {
      log,
      requestId,
    };
  }
}
