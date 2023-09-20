import { metricScope, MetricsLogger } from 'aws-embedded-metrics';
import { ScheduledHandler } from 'aws-lambda/trigger/cloudwatch-events';
import { EventBridgeEvent } from 'aws-lambda/trigger/eventbridge';
import Logger from 'bunyan';

import { FADE_RATE_BUCKET, FADE_RATE_S3_KEY, PRODUCTION_S3_KEY, WEBHOOK_CONFIG_BUCKET } from '../constants';
import { CircuitBreakerMetricDimension } from '../entities';
import { checkDefined } from '../preconditions/preconditions';
import { S3WebhookConfigurationProvider } from '../providers';
import { S3CircuitBreakerConfigurationProvider } from '../providers/circuit-breaker/s3';
import { FadesRepository, FadesRowType, SharedConfigs } from '../repositories';

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
  const webhookProvider = new S3WebhookConfigurationProvider(log, `${WEBHOOK_CONFIG_BUCKET}-prod-1`, PRODUCTION_S3_KEY);

  const sharedConfig: SharedConfigs = {
    Database: checkDefined(process.env.REDSHIFT_DATABASE),
    ClusterIdentifier: checkDefined(process.env.REDSHIFT_CLUSTER_IDENTIFIER),
    SecretArn: checkDefined(process.env.REDSHIFT_SECRET_ARN),
  };
  const fadesRepository = FadesRepository.create(sharedConfig);
  await fadesRepository.createFadesView();
  const result = await fadesRepository.getFades();

  if (result) {
    const addressToFiller = await webhookProvider.addressToFiller();
    const fillerFadeRate = calculateFillerFadeRates(result, addressToFiller, log);
    log.info({ fadeRates: [...fillerFadeRate.entries()] }, 'filler fade rate');

    const configProvider = new S3CircuitBreakerConfigurationProvider(
      log,
      `${FADE_RATE_BUCKET}-prod-1`,
      FADE_RATE_S3_KEY
    );
    //TODO: fire an alert when circuit breaker is triggered
    await configProvider.putConfigurations(fillerFadeRate, metrics);
  }
}

// aggregates potentially multiple filler addresses into filler name
// and calculates fade rate for each
export function calculateFillerFadeRates(
  rows: FadesRowType[],
  addressToFiller: Map<string, string>,
  log?: Logger
): Map<string, number> {
  const fadeRateMap = new Map<string, number>();
  const fillerToQuotesMap = new Map<string, [number, number]>();
  rows.forEach((row) => {
    const fillerAddr = row.fillerAddress.toLowerCase();
    const fillerName = addressToFiller.get(fillerAddr);
    if (!fillerName) {
      log?.info({ addressToFiller, fillerAddress: fillerAddr }, 'filler address not found in webhook config');
    } else {
      if (!fillerToQuotesMap.has(fillerName)) {
        fillerToQuotesMap.set(fillerName, [row.fadedQuotes, row.totalQuotes]);
      } else {
        const [fadedQuotes, totalQuotes] = fillerToQuotesMap.get(fillerName) as [number, number];
        fillerToQuotesMap.set(fillerName, [fadedQuotes + row.fadedQuotes, totalQuotes + row.totalQuotes]);
      }
    }
    log?.info({ fillerToQuotesMap }, 'filler to quotes map');
  });

  fillerToQuotesMap.forEach((value, key) => {
    const fadeRate = value[0] / value[1];
    fadeRateMap.set(key, fadeRate);
  });
  return fadeRateMap;
}
