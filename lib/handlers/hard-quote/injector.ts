import { KMSClient } from '@aws-sdk/client-kms';
import { KmsSigner } from '@uniswap/signer';
import { IMetric, setGlobalLogger, setGlobalMetric } from '@uniswap/smart-order-router';
import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as bunyan, default as Logger } from 'bunyan';

import {
  BETA_S3_KEY,
  FADE_RATE_BUCKET,
  FADE_RATE_S3_KEY,
  PRODUCTION_S3_KEY,
  WEBHOOK_CONFIG_BUCKET,
} from '../../constants';
import { AWSMetricsLogger, UniswapXParamServiceMetricDimension } from '../../entities/aws-metrics-logger';
import { checkDefined } from '../../preconditions/preconditions';
import { S3WebhookConfigurationProvider } from '../../providers';
import { FirehoseLogger } from '../../providers/analytics';
import { S3CircuitBreakerConfigurationProvider } from '../../providers/circuit-breaker/s3';
import { MockFillerComplianceConfigurationProvider } from '../../providers/compliance';
import { Quoter, WebhookQuoter } from '../../quoters';
import { STAGE } from '../../util/stage';
import { ApiInjector, ApiRInj } from '../base/api-handler';
import { HardQuoteRequestBody } from './schema';

export interface ContainerInjected {
  quoters: Quoter[];
  firehose: FirehoseLogger;
  cosigner: KmsSigner;
}

export interface RequestInjected extends ApiRInj {
  metric: IMetric;
}

export class QuoteInjector extends ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void> {
  public async buildContainerInjected(): Promise<ContainerInjected> {
    const log: Logger = bunyan.createLogger({
      name: this.injectorName,
      serializers: bunyan.stdSerializers,
      level: bunyan.INFO,
    });

    const stage = process.env['stage'];
    const s3Key = stage === STAGE.BETA ? BETA_S3_KEY : PRODUCTION_S3_KEY;

    const circuitBreakerProvider = new S3CircuitBreakerConfigurationProvider(
      log,
      `${FADE_RATE_BUCKET}-${stage}-1`,
      FADE_RATE_S3_KEY
    );

    const kmsKeyId = checkDefined(process.env.KMS_KEY_ID, 'KMS_KEY_ID is not defined');
    const awsRegion = checkDefined(process.env.REGION, 'REGION is not defined');
    const cosigner = new KmsSigner(new KMSClient({ region: awsRegion }), kmsKeyId);

    const webhookProvider = new S3WebhookConfigurationProvider(log, `${WEBHOOK_CONFIG_BUCKET}-${stage}-1`, s3Key);
    await webhookProvider.fetchEndpoints();

    // TODO: decide if we should handle filler compliance differently
    //const complianceKey = stage === STAGE.BETA ? BETA_COMPLIANCE_S3_KEY : PROD_COMPLIANCE_S3_KEY;
    //const fillerComplianceProvider = new S3FillerComplianceConfigurationProvider(
    //  log,
    //  `${COMPLIANCE_CONFIG_BUCKET}-${stage}-1`,
    //  complianceKey
    //);
    const fillerComplianceProvider = new MockFillerComplianceConfigurationProvider([]);

    const firehose = new FirehoseLogger(log, process.env.ANALYTICS_STREAM_ARN!);

    const quoters: Quoter[] = [
      new WebhookQuoter(log, firehose, webhookProvider, circuitBreakerProvider, fillerComplianceProvider),
    ];
    return {
      quoters: quoters,
      firehose: firehose,
      cosigner,
    };
  }

  public async getRequestInjected(
    _containerInjected: ContainerInjected,
    requestBody: HardQuoteRequestBody,
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
