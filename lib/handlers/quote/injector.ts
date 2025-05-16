import { IMetric, setGlobalLogger, setGlobalMetric } from '@uniswap/smart-order-router';
import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as bunyan, default as Logger } from 'bunyan';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  BETA_COMPLIANCE_S3_KEY,
  BETA_S3_KEY,
  COMPLIANCE_CONFIG_BUCKET,
  PRODUCTION_S3_KEY,
  PROD_COMPLIANCE_S3_KEY,
  RPC_HEADERS,
  WEBHOOK_CONFIG_BUCKET,
} from '../../constants';
import { AWSMetricsLogger, SoftQuoteMetricDimension } from '../../entities/aws-metrics-logger';
import { S3WebhookConfigurationProvider } from '../../providers';
import { FirehoseLogger } from '../../providers/analytics';
import { DynamoCircuitBreakerConfigurationProvider } from '../../providers/circuit-breaker/dynamo';
import { S3FillerComplianceConfigurationProvider } from '../../providers/compliance/s3';
import { Quoter, WebhookQuoter } from '../../quoters';
import { DynamoFillerAddressRepository } from '../../repositories/filler-address-repository';
import { STAGE } from '../../util/stage';
import { ApiInjector, ApiRInj } from '../base/api-handler';
import { PostQuoteRequestBody } from './schema';
import { ChainId, supportedChains } from '../../util/chains';
import { ethers } from 'ethers';
import { checkDefined } from '../../preconditions/preconditions';

export interface ContainerInjected {
  quoters: Quoter[];
  firehose: FirehoseLogger;
  chainIdRpcMap: Map<ChainId, ethers.providers.StaticJsonRpcProvider>;
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
    const circuitBreakerProvider = new DynamoCircuitBreakerConfigurationProvider(log, webhookProvider);

    const complianceKey = stage === STAGE.BETA ? BETA_COMPLIANCE_S3_KEY : PROD_COMPLIANCE_S3_KEY;
    const fillerComplianceProvider = new S3FillerComplianceConfigurationProvider(
      log,
      `${COMPLIANCE_CONFIG_BUCKET}-${stage}-1`,
      complianceKey
    );

    const firehose = new FirehoseLogger(log, process.env.ANALYTICS_STREAM_ARN!);

    const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: {
        convertEmptyValues: true,
      },
      unmarshallOptions: {
        wrapNumbers: true,
      },
    });
    const repository = DynamoFillerAddressRepository.create(documentClient);

    const quoters: Quoter[] = [
      new WebhookQuoter(log, firehose, webhookProvider, circuitBreakerProvider, fillerComplianceProvider, repository),
    ];

    const chainIdRpcMap = new Map<ChainId, ethers.providers.StaticJsonRpcProvider>();
    supportedChains.forEach(
      chainId => {
        const rpcUrl = checkDefined(
          process.env[`RPC_${chainId}`],
          `RPC_${chainId} is not defined`
        );
        const provider = new ethers.providers.StaticJsonRpcProvider({
          url: rpcUrl,
          headers: RPC_HEADERS
        }, chainId)
        chainIdRpcMap.set(chainId, provider);
      }
    );

    return {
      quoters: quoters,
      firehose: firehose,
      chainIdRpcMap: chainIdRpcMap,
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
    metricsLogger.setDimensions(SoftQuoteMetricDimension);
    const metric = new AWSMetricsLogger(metricsLogger);
    setGlobalMetric(metric);

    return {
      log,
      metric,
      requestId,
    };
  }
}
