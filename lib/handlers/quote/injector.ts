import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as bunyan, default as Logger } from 'bunyan';

import { JsonWebhookConfigurationProvider } from '../../providers';
import { MockQuoter, Quoter, WebhookQuoter } from '../../quoters';
import { ApiInjector, ApiRInj } from '../base/api-handler';
import { PostQuoteRequestBody } from './schema';

export interface ContainerInjected {
  quoters: Quoter[];
}

export class QuoteInjector extends ApiInjector<ContainerInjected, ApiRInj, PostQuoteRequestBody, void> {
  public async buildContainerInjected(): Promise<ContainerInjected> {
    const log: Logger = bunyan.createLogger({
      name: this.injectorName,
      serializers: bunyan.stdSerializers,
      level: bunyan.INFO,
    });
    const webhookProvider = new JsonWebhookConfigurationProvider();

    return {
      quoters: [new MockQuoter(log, 1, 1), new MockQuoter(log, 3, 2), new WebhookQuoter(log, webhookProvider)],
    };
  }

  public async getRequestInjected(
    containerInjected: ContainerInjected,
    _requestBody: PostQuoteRequestBody,
    _requestQueryParams: void,
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
