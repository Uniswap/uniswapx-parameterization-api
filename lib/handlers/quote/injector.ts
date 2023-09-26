import { IMetric, setGlobalLogger, setGlobalMetric } from '@uniswap/smart-order-router';
import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as bunyan, default as Logger } from 'bunyan';

import {
  BETA_S3_KEY,
  FADE_RATE_BUCKET,
  FADE_RATE_S3_KEY,
  INTEGRATION_S3_KEY,
  PRODUCTION_S3_KEY,
  WEBHOOK_CONFIG_BUCKET,
} from '../../constants';
import {
  AWSMetricsLogger,
  UniswapXParamServiceIntegrationMetricDimension,
  UniswapXParamServiceMetricDimension,
} from '../../entities/aws-metrics-logger';
import { S3WebhookConfigurationProvider } from '../../providers';
import { S3CircuitBreakerConfigurationProvider } from '../../providers/circuit-breaker/s3';
import { Quoter, WebhookQuoter } from '../../quoters';
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

    const stage = process.env['stage'];
    const s3Key = stage === STAGE.BETA ? BETA_S3_KEY : PRODUCTION_S3_KEY;
    const webhookProvider = new S3WebhookConfigurationProvider(log, `${WEBHOOK_CONFIG_BUCKET}-${stage}-1`, s3Key);

    const circuitBreakerProvider = new S3CircuitBreakerConfigurationProvider(
      log,
      `${FADE_RATE_BUCKET}-${stage}-1`,
      FADE_RATE_S3_KEY
    );
    const quoters: Quoter[] = [new WebhookQuoter(log, webhookProvider, circuitBreakerProvider)];
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
    metricsLogger.setDimensions(UniswapXParamServiceMetricDimension);
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

    const stage = process.env['stage'];
    const webhookProvider = new S3WebhookConfigurationProvider(
      log,
      `${WEBHOOK_CONFIG_BUCKET}-${stage}-1`,
      INTEGRATION_S3_KEY
    );
    const circuitBreakerProvider = new S3CircuitBreakerConfigurationProvider(
      log,
      `${FADE_RATE_BUCKET}-${stage}-1`,
      FADE_RATE_S3_KEY
    );
    const quoters: Quoter[] = [new WebhookQuoter(log, webhookProvider, circuitBreakerProvider)];

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
    metricsLogger.setDimensions(UniswapXParamServiceIntegrationMetricDimension);
    const metric = new AWSMetricsLogger(metricsLogger);
    setGlobalMetric(metric);

    return {
      log,
      metric,
      requestId,
    };
  }
}
