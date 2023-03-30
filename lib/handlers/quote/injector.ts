import { IMetric, setGlobalLogger, setGlobalMetric } from '@uniswap/smart-order-router';
import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as bunyan, default as Logger } from 'bunyan';

import { AWSMetricsLogger } from '../../entities/aws-metrics-logger';
import { JsonWebhookConfigurationProvider } from '../../providers';
import { Quoter, WebhookQuoter } from '../../quoters';
import { MockQuoter } from '../../quoters/MockQuoter';
import { STAGE } from '../../util/stage';
import { ApiInjector, ApiRInj } from '../base/api-handler';
import { PostQuoteRequestBody } from './schema';

export interface ContainerInjected {
  quoters: Quoter[];
}

export interface RequestInjected extends ApiRInj {
  metric: IMetric;
}

export class QuoteInjector extends ApiInjector<ContainerInjected, RequestInjected, PostQuoteRequestBody, void> {
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

    const quoters: Quoter[] = [new WebhookQuoter(log, webhookProvider)];
    if (process.env['stage'] == STAGE.LOCAL) {
      quoters.push(new MockQuoter(log));
    }
    return {
      quoters: quoters,
    };
  }

  public async getRequestInjected(
    _containerInjected: ContainerInjected,
    requestBody: PostQuoteRequestBody,
    _requestQueryParams: void,
    _event: APIGatewayProxyEvent,
    context: Context,
    log: Logger,
    metricsLogger: MetricsLogger
  ): Promise<RequestInjected> {
    const requestId = context.awsRequestId;

    log = log.child({
      serializers: bunyan.stdSerializers,
      requestBody,
      requestId,
    });
    setGlobalLogger(log);

    metricsLogger.setNamespace('Uniswap');
    metricsLogger.setDimensions({ Service: 'GoudaParameterizationAPI' });
    const metric = new AWSMetricsLogger(metricsLogger);
    setGlobalMetric(metric);

    return {
      log,
      metric,
      requestId,
    };
  }
}
