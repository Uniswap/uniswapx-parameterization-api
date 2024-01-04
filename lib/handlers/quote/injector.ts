import { IMetric, setGlobalLogger, setGlobalMetric } from '@uniswap/smart-order-router';
import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as bunyan, default as Logger } from 'bunyan';

import {
  BETA_COMPLIANCE_S3_KEY,
  BETA_S3_KEY,
  COMPLIANCE_CONFIG_BUCKET,
  PRODUCTION_S3_KEY,
  PROD_COMPLIANCE_S3_KEY,
  WEBHOOK_CONFIG_BUCKET,
} from '../../constants';
import { AWSMetricsLogger, UniswapXParamServiceMetricDimension } from '../../entities/aws-metrics-logger';
import { S3WebhookConfigurationProvider } from '../../providers';
import { FirehoseLogger } from '../../providers/analytics';
import { DynamoCircuitBreakerConfigurationProvider } from '../../providers/circuit-breaker/dynamo';
import { S3FillerComplianceConfigurationProvider } from '../../providers/compliance/s3';
import { Quoter, WebhookQuoter } from '../../quoters';
import { STAGE } from '../../util/stage';
import { ApiInjector, ApiRInj } from '../base/api-handler';
import { PostQuoteRequestBody } from './schema';

export interface ContainerInjected {
  quoters: Quoter[];
  firehose: FirehoseLogger;
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
    await webhookProvider.fetchEndpoints();

    const circuitBreakerProvider = new DynamoCircuitBreakerConfigurationProvider(log, webhookProvider.fillers());

    const complianceKey = stage === STAGE.BETA ? BETA_COMPLIANCE_S3_KEY : PROD_COMPLIANCE_S3_KEY;
    const fillerComplianceProvider = new S3FillerComplianceConfigurationProvider(
      log,
      `${COMPLIANCE_CONFIG_BUCKET}-${stage}-1`,
      complianceKey
    );

    const firehose = new FirehoseLogger(log, process.env.ANALYTICS_STREAM_ARN!);

    const quoters: Quoter[] = [
      new WebhookQuoter(log, firehose, webhookProvider, circuitBreakerProvider, fillerComplianceProvider),
    ];
    return {
      quoters: quoters,
      firehose: firehose,
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
