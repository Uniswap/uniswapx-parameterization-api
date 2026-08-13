import { IMetric, setGlobalLogger, setGlobalMetric } from '@uniswap/smart-order-router';
import { MetricsLogger } from 'aws-embedded-metrics';
import { Context } from 'aws-lambda';
import { default as bunyan, default as Logger } from 'bunyan';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ethers } from 'ethers';
import { BETA_S3_KEY, PRODUCTION_S3_KEY, RPC_HEADERS, WEBHOOK_CONFIG_BUCKET } from '../../constants';
import { AWSMetricsLogger } from '../../entities/aws-metrics-logger';
import { S3WebhookConfigurationProvider } from '../../providers';
import { FirehoseLogger } from '../../providers/analytics';
import { DynamoCircuitBreakerConfigurationProvider } from '../../providers/circuit-breaker/dynamo';
import { FillerComplianceConfigurationProvider } from '../../providers/compliance';
import { Quoter, WebhookQuoter } from '../../quoters';
import { DynamoFillerAddressRepository } from '../../repositories/filler-address-repository';
import { ChainId, getRpcUrl, SUPPORTED_CHAINS } from '../../util/chains';
import { STAGE } from '../../util/stage';
import { ApiRInj } from '../base/api-handler';

/** Container state shared by both quote Lambdas (soft `/quote` and hard `/hard-quote`). */
export interface BaseQuoteContainerInjected {
  quoters: Quoter[];
  firehose: FirehoseLogger;
  chainIdRpcMap: Map<ChainId, ethers.providers.StaticJsonRpcProvider>;
}

/** Per-request state shared by both quote Lambdas. */
export interface BaseQuoteRequestInjected extends ApiRInj {
  metric: IMetric;
}

/**
 * Builds the injector's root logger. The `name` field lands on every log line the
 * providers and quoters emit, so it stays the injector's own name.
 */
export function createInjectorLogger(injectorName: string): Logger {
  return bunyan.createLogger({
    name: injectorName,
    serializers: bunyan.stdSerializers,
    level: bunyan.INFO,
  });
}

/**
 * One RPC provider per supported chain. The chainId is passed as the second constructor
 * argument so ethers treats the network as static and skips an `eth_chainId` round trip
 * on cold start.
 */
export function buildChainIdRpcMap(): Map<ChainId, ethers.providers.StaticJsonRpcProvider> {
  const chainIdRpcMap = new Map<ChainId, ethers.providers.StaticJsonRpcProvider>();
  SUPPORTED_CHAINS.forEach((chainId) => {
    const provider = new ethers.providers.StaticJsonRpcProvider(
      {
        url: getRpcUrl(chainId),
        headers: RPC_HEADERS,
      },
      chainId
    );
    chainIdRpcMap.set(chainId, provider);
  });
  return chainIdRpcMap;
}

/**
 * Builds the RFQ container both quote Lambdas share. Callers supply their own compliance
 * provider because the two Lambdas deliberately differ there — see each injector.
 *
 * INVARIANT: exactly one S3WebhookConfigurationProvider is created here and that same
 * instance is given to both the circuit breaker and the WebhookQuoter. The circuit breaker
 * reads `fillerEndpoints()`, a cache populated only by the quoter's `getEndpoints()` call
 * one line earlier in the request path. Two instances would leave the breaker's timestamp
 * map empty, which fails open — every benched filler silently re-enabled, with no error
 * and no metric. The types do not protect against this: the breaker takes the concrete
 * S3WebhookConfigurationProvider while the quoter takes only the interface, so a split
 * compiles cleanly.
 *
 * Construction is synchronous and does no I/O; every client here is lazy. It must stay
 * inside the injector call (not module scope) so BaseInjector.build() keeps caching one
 * container per Lambda execution environment, preserving each provider's refresh window.
 */
export function buildQuoteContainerInjected(
  log: Logger,
  stage: string | undefined,
  fillerComplianceProvider: FillerComplianceConfigurationProvider
): BaseQuoteContainerInjected {
  const s3Key = stage === STAGE.BETA ? BETA_S3_KEY : PRODUCTION_S3_KEY;

  const webhookProvider = new S3WebhookConfigurationProvider(log, `${WEBHOOK_CONFIG_BUCKET}-${stage}-1`, s3Key);
  const circuitBreakerProvider = new DynamoCircuitBreakerConfigurationProvider(log, webhookProvider);

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

  return {
    quoters,
    firehose,
    chainIdRpcMap: buildChainIdRpcMap(),
  };
}

/**
 * Per-request logger and metric setup, identical for both quote Lambdas apart from the
 * metric dimension. Takes an options object because the only thing that varies is a
 * dimension constant structurally identical to the other Lambda's, which a positional
 * argument would make easy to swap silently.
 *
 * The call order is load-bearing: `setDimensions` REPLACES the dimension-set list while
 * `putDimensions` APPENDS one, so the per-chain set must be added second. `setGlobalMetric`
 * must run because WebhookQuoter emits every RFQ_* metric through the smart-order-router
 * module global rather than the injected IMetric.
 */
export function buildQuoteRequestInjected<ReqBody extends { tokenInChainId: number }>(params: {
  requestBody: ReqBody;
  context: Context;
  log: Logger;
  metricsLogger: MetricsLogger;
  metricDimension: Record<string, string>;
}): BaseQuoteRequestInjected {
  const { requestBody, context, metricsLogger, metricDimension } = params;
  const requestId = context.awsRequestId;

  const log = params.log.child({
    serializers: bunyan.stdSerializers,
    requestBody,
    requestId,
  });
  setGlobalLogger(log);

  metricsLogger.setNamespace('Uniswap');
  metricsLogger.setDimensions(metricDimension);
  // additional dimension set so every metric is also queryable per-chain
  metricsLogger.putDimensions({
    ...metricDimension,
    ChainId: requestBody.tokenInChainId.toString(),
  });
  // Third, dimensionless rollup set (serializes as `[]` in the EMF Dimensions array).
  // CloudWatch percentiles cannot be merged across dimension values post-hoc, and the
  // latency dashboard's headline needs one combined all-services stream; because soft and
  // hard emit the same metric names, their dimensionless streams merge into a single
  // series per metric.
  metricsLogger.putDimensions({});
  const metric = new AWSMetricsLogger(metricsLogger);
  setGlobalMetric(metric);

  return {
    log,
    metric,
    requestId,
  };
}
