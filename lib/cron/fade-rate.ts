import { metricScope, MetricsLogger } from 'aws-embedded-metrics';
import { ScheduledHandler } from 'aws-lambda/trigger/cloudwatch-events';
import { EventBridgeEvent } from 'aws-lambda/trigger/eventbridge';
import Logger from 'bunyan';

import {
  BETA_S3_KEY,
  FADE_RATE_BUCKET,
  FADE_RATE_S3_KEY,
  PRODUCTION_S3_KEY,
  WEBHOOK_CONFIG_BUCKET,
} from '../constants';
import { CircuitBreakerMetricDimension } from '../entities';
import { checkDefined } from '../preconditions/preconditions';
import { S3WebhookConfigurationProvider } from '../providers';
import { S3CircuitBreakerConfigurationProvider } from '../providers/circuit-breaker/s3';
import { FadesRepository, FadesRowType, SharedConfigs } from '../repositories';
import { STAGE } from '../util/stage';

export const handler: ScheduledHandler = metricScope((metrics) => async (_event: EventBridgeEvent<string, void>) => {
  await main(metrics);
});

async function main(metrics: MetricsLogger) {
  metrics.setNamespace('Uniswap');
  metrics.setDimensions(CircuitBreakerMetricDimension);

  const log = Logger.createLogger({
    name: 'FadeRate',
    serializers: Logger.stdSerializers,
  });
  const stage = process.env['stage'];
  const s3Key = stage === STAGE.BETA ? BETA_S3_KEY : PRODUCTION_S3_KEY;
  const webhookProvider = new S3WebhookConfigurationProvider(log, `${WEBHOOK_CONFIG_BUCKET}-${stage}-1`, s3Key);

  const sharedConfig: SharedConfigs = {
    Database: checkDefined(process.env.REDSHIFT_DATABASE),
    ClusterIdentifier: checkDefined(process.env.REDSHIFT_CLUSTER_IDENTIFIER),
    SecretArn: checkDefined(process.env.REDSHIFT_SECRET_ARN),
  };
  const fadesRepository = FadesRepository.create(sharedConfig);
  await fadesRepository.createFadesView();
  const result = await fadesRepository.getFades();

  if (result) {
    const addressToFillerHash = await webhookProvider.addressToFillerHash();
    const fillerFadeRate = calculateFillerFadeRates(result, addressToFillerHash, log);
    log.info({ fadeRates: [...fillerFadeRate.entries()] }, 'filler fade rate');

    const configProvider = new S3CircuitBreakerConfigurationProvider(
      log,
      `${FADE_RATE_BUCKET}-prod-1`,
      FADE_RATE_S3_KEY
    );
    await configProvider.putConfigurations(fillerFadeRate, metrics);
  }
}

// aggregates potentially multiple filler addresses into filler name
// and calculates fade rate for each
export function calculateFillerFadeRates(
  rows: FadesRowType[],
  addressToFillerHash: Map<string, string>,
  log?: Logger
): Map<string, number> {
  const fadeRateMap = new Map<string, number>();
  const fillerToQuotesMap = new Map<string, [number, number]>();
  rows.forEach((row) => {
    const fillerAddr = row.fillerAddress.toLowerCase();
    const fillerHash = addressToFillerHash.get(fillerAddr);
    if (!fillerHash) {
      log?.info({ addressToFillerHash, fillerAddress: fillerAddr }, 'filler address not found in webhook config');
    } else {
      if (!fillerToQuotesMap.has(fillerHash)) {
        fillerToQuotesMap.set(fillerHash, [row.fadedQuotes, row.totalQuotes]);
      } else {
        const [fadedQuotes, totalQuotes] = fillerToQuotesMap.get(fillerHash) as [number, number];
        fillerToQuotesMap.set(fillerHash, [fadedQuotes + row.fadedQuotes, totalQuotes + row.totalQuotes]);
      }
    }
  });

  fillerToQuotesMap.forEach((value, key) => {
    const fadeRate = value[0] / value[1];
    fadeRateMap.set(key, fadeRate);
  });
  return fadeRateMap;
}
