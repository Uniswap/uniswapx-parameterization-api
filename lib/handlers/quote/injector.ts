import { setGlobalLogger } from '@uniswap/smart-order-router';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as bunyan, default as Logger } from 'bunyan';

import { JsonWebhookConfigurationProvider } from '../../providers';
import { MockQuoter, Quoter, WebhookQuoter } from '../../quoters';
import { STAGE } from '../../util/stage';
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

    if (process.env['stage'] == STAGE.LOCAL || process.env['stage'] == STAGE.BETA) {
      process.env['RPC_1'] = process.env['RPC_TENDERLY'];
    }

    const webhookProvider = new JsonWebhookConfigurationProvider();

    return {
      quoters: [new WebhookQuoter(log, webhookProvider), new MockQuoter(log, 1, 1)],
    };
  }

  public async getRequestInjected(
    _containerInjected: ContainerInjected,
    requestBody: PostQuoteRequestBody,
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
