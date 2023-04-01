import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { IMetric, setGlobalLogger, setGlobalMetric } from '@uniswap/smart-order-router';
import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as bunyan, default as Logger } from 'bunyan';

import { INTEGRATION_WEBHOOK_CONFIG_KEY, PRODUCTION_WEBHOOK_CONFIG_KEY, WEBHOOK_CONFIG_BUCKET } from '../../constants';
import { AWSMetricsLogger } from '../../entities/aws-metrics-logger';
import { checkDefined } from '../../preconditions/preconditions';
import { ExternalWebhookConfigurationProvider, WebhookConfiguration } from '../../providers';
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

    const s3Client = new S3Client({});
    const s3Res = await s3Client.send(
      new GetObjectCommand({
        Bucket: WEBHOOK_CONFIG_BUCKET + `-${process.env['stage']}`,
        Key: PRODUCTION_WEBHOOK_CONFIG_KEY,
      })
    );
    const s3Body = checkDefined(s3Res.Body, 's3Res.Body is undefined');
    const s3Json = JSON.parse(await s3Body.transformToString()) as WebhookConfiguration;
    const webhookProvider = new ExternalWebhookConfigurationProvider([s3Json]);

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

export class MockQuoteInjector extends ApiInjector<ContainerInjected, RequestInjected, PostQuoteRequestBody, void> {
  public async buildContainerInjected(): Promise<ContainerInjected> {
    const log: Logger = bunyan.createLogger({
      name: this.injectorName,
      serializers: bunyan.stdSerializers,
      level: bunyan.INFO,
    });

    const s3Client = new S3Client({});
    const s3Res = await s3Client.send(
      new GetObjectCommand({ Bucket: WEBHOOK_CONFIG_BUCKET, Key: INTEGRATION_WEBHOOK_CONFIG_KEY })
    );
    const s3Body = checkDefined(s3Res.Body, 's3Res.Body is undefined');
    const s3Json = JSON.parse(await s3Body.transformToString()) as WebhookConfiguration;
    const webhookProvider = new ExternalWebhookConfigurationProvider([s3Json]);

    const quoters: Quoter[] = [new WebhookQuoter(log, webhookProvider)];
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
    metricsLogger.setDimensions({ Service: 'GoudaParameterizationAPI-Integration' });
    const metric = new AWSMetricsLogger(metricsLogger);
    setGlobalMetric(metric);

    return {
      log,
      metric,
      requestId,
    };
  }
}
