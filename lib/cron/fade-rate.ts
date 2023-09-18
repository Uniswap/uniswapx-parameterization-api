import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { metricScope, MetricsLogger } from 'aws-embedded-metrics';
import { ScheduledHandler } from 'aws-lambda/trigger/cloudwatch-events';
import { EventBridgeEvent } from 'aws-lambda/trigger/eventbridge';
import Logger from 'bunyan';
import { Entity, Table } from 'dynamodb-toolbox';

import { DYNAMO_TABLE_KEY, DYNAMO_TABLE_NAME, PRODUCTION_S3_KEY, WEBHOOK_CONFIG_BUCKET } from '../constants';
import { checkDefined } from '../preconditions/preconditions';
import { S3WebhookConfigurationProvider } from '../providers';
import { FadesRepository, FadesRowType, SharedConfigs } from '../repositories';

export const handler: ScheduledHandler = metricScope((metrics) => async (_event: EventBridgeEvent<string, void>) => {
  await main(metrics);
});

async function main(metrics: MetricsLogger) {
  metrics.setNamespace('Uniswap');
  metrics.setDimensions({
    Service: 'FadeRate',
  });

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

  const fadeRateEntity = createDynamoEntity();

  if (result) {
    await webhookProvider.getEndpoints();
    const addressToFiller = webhookProvider.addressToFiller();
    const fillerFadeRate = calculateFillerFadeRates(result, addressToFiller, log);
    log.info({ fillerFadeRate }, 'filler fade rate');
    fillerFadeRate.forEach((fadeRate, filler) => {
      fadeRateEntity.put({ filler, faderate: fadeRate });
    });
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
    const fillerName = addressToFiller.get(row.fillerAddress);
    if (!fillerName) {
      log?.info({ fillerAddress: row.fillerAddress }, 'filler address not found in webhook config');
    } else {
      if (!fillerToQuotesMap.has(fillerName)) {
        fillerToQuotesMap.set(fillerName, [row.fadedQuotes, row.totalQuotes]);
      } else {
        const [fadedQuotes, totalQuotes] = fillerToQuotesMap.get(fillerName) as [number, number];
        fillerToQuotesMap.set(fillerName, [fadedQuotes + row.fadedQuotes, totalQuotes + row.totalQuotes]);
      }
    }
  });

  fillerToQuotesMap.forEach((value, key) => {
    const fadeRate = value[0] / value[1];
    fadeRateMap.set(key, fadeRate);
  });
  return fadeRateMap;
}

function createDynamoEntity() {
  const DocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: {
      convertEmptyValues: true,
    },
    unmarshallOptions: {
      wrapNumbers: true,
    },
  });

  const table = new Table({
    name: DYNAMO_TABLE_NAME.FADES,
    partitionKey: DYNAMO_TABLE_KEY.FILLER,
    DocumentClient,
  });

  return new Entity({
    name: `${DYNAMO_TABLE_NAME.FADES}Entity`,
    attributes: {
      filler: { partitionKey: true, type: 'string' },
      faderate: { type: 'number' },
    },
    table: table,
    autoExecute: true,
  } as const);
}
