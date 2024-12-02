import { IMetric, setGlobalLogger, setGlobalMetric } from '@uniswap/smart-order-router';
import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as bunyan, default as Logger } from 'bunyan';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { BETA_S3_KEY, PRODUCTION_S3_KEY, WEBHOOK_CONFIG_BUCKET } from '../../constants';
import { AWSMetricsLogger, HardQuoteMetricDimension } from '../../entities/aws-metrics-logger';
import { checkDefined } from '../../preconditions/preconditions';
import { OrderServiceProvider, S3WebhookConfigurationProvider, UniswapXServiceProvider } from '../../providers';
import { FirehoseLogger } from '../../providers/analytics';
import { DynamoCircuitBreakerConfigurationProvider } from '../../providers/circuit-breaker/dynamo';
import { MockFillerComplianceConfigurationProvider } from '../../providers/compliance';
import { Quoter, WebhookQuoter } from '../../quoters';
import { DynamoFillerAddressRepository } from '../../repositories/filler-address-repository';
import { STAGE } from '../../util/stage';
import { ApiInjector, ApiRInj } from '../base/api-handler';
import { HardQuoteRequestBody } from './schema';
import { ethers } from 'ethers';
import { ChainId, supportedChains } from '../../util/chains';

export interface ContainerInjected {
  quoters: Quoter[];
  firehose: FirehoseLogger;
  orderServiceProvider: OrderServiceProvider;
  chainIdRpcMap: Map<ChainId, ethers.providers.StaticJsonRpcProvider>;
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

    const orderServiceUrl = checkDefined(process.env.ORDER_SERVICE_URL, 'ORDER_SERVICE_URL is not defined');

    const webhookProvider = new S3WebhookConfigurationProvider(log, `${WEBHOOK_CONFIG_BUCKET}-${stage}-1`, s3Key);
    const circuitBreakerProvider = new DynamoCircuitBreakerConfigurationProvider(log, webhookProvider);

    const orderServiceProvider = new UniswapXServiceProvider(log, orderServiceUrl);

    // TODO: decide if we should handle filler compliance differently
    //const complianceKey = stage === STAGE.BETA ? BETA_COMPLIANCE_S3_KEY : PROD_COMPLIANCE_S3_KEY;
    //const fillerComplianceProvider = new S3FillerComplianceConfigurationProvider(
    //  log,
    //  `${COMPLIANCE_CONFIG_BUCKET}-${stage}-1`,
    //  complianceKey
    //);
    const fillerComplianceProvider = new MockFillerComplianceConfigurationProvider([]);

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

    const chainIdRpcMap = new Map<ChainId, ethers.providers.JsonRpcProvider>();
    supportedChains.forEach(
      chainId => {
        const rpcUrl = checkDefined(
          process.env[`RPC_${chainId}`],
          `RPC_${chainId} is not defined`
        );
        const provider = new ethers.providers.JsonRpcProvider(rpcUrl, chainId);
        chainIdRpcMap.set(chainId, provider);
      }
    );

    return {
      quoters: quoters,
      firehose: firehose,
      orderServiceProvider,
      chainIdRpcMap,
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
    metricsLogger.setDimensions(HardQuoteMetricDimension);
    const metric = new AWSMetricsLogger(metricsLogger);
    setGlobalMetric(metric);

    return {
      log,
      metric,
      requestId,
    };
  }
}
