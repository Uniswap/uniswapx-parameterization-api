import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { metricScope, MetricsLogger } from 'aws-embedded-metrics';
import { ScheduledHandler } from 'aws-lambda/trigger/cloudwatch-events';
import { EventBridgeEvent } from 'aws-lambda/trigger/eventbridge';
import Logger from 'bunyan';

import {
  BETA_S3_KEY,
  FADE_RATE_BUCKET,
  FADE_RATE_S3_KEY,
  FILL_RATE_THRESHOLD,
  PRODUCTION_S3_KEY,
  WEBHOOK_CONFIG_BUCKET,
} from '../constants';
import { CircuitBreakerMetricDimension } from '../entities';
import { checkDefined } from '../preconditions/preconditions';
import { S3WebhookConfigurationProvider } from '../providers';
import { S3CircuitBreakerConfigurationProvider } from '../providers/circuit-breaker/s3';
import { BaseTimestampRepository, FadesRepository, FadesRowType, SharedConfigs } from '../repositories';
import { TimestampRepository } from '../repositories/timestamp-repository';
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
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: {
      convertEmptyValues: true,
    },
    unmarshallOptions: {
      wrapNumbers: true,
    },
  });
  const timestampDB = TimestampRepository.create(documentClient);

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
    const fillersNewFades = calculateFillerFadeRates(result, addressToFillerHash, log);
    log.info({ fadeRates: [...fillerFadeRate.entries()] }, 'filler fade rate');

    const toUpdate = [...fillerFadeRate.entries()].filter(([, rate]) => rate >= FILL_RATE_THRESHOLD);
    log.info({ toUpdate }, 'filler for which to update timestamp');
    await timestampDB.updateTimestampsBatch(toUpdate, Math.floor(Date.now() / 1000));
  }
}

export function getFillersNewFades(
  rows: FadesRowType[],
  addressToFillerHash: Map<string, string>,
  log?: Logger
): Map<string, [number, number]> {
  const;
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
