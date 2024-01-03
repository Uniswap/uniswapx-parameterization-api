import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { metricScope, MetricsLogger } from 'aws-embedded-metrics';
import { ScheduledHandler } from 'aws-lambda/trigger/cloudwatch-events';
import { EventBridgeEvent } from 'aws-lambda/trigger/eventbridge';
import Logger from 'bunyan';

import { BETA_S3_KEY, PRODUCTION_S3_KEY, WEBHOOK_CONFIG_BUCKET } from '../constants';
import { CircuitBreakerMetricDimension } from '../entities';
import { checkDefined } from '../preconditions/preconditions';
import { S3WebhookConfigurationProvider } from '../providers';
import { FadesRepository, FadesRowType, SharedConfigs, TimestampRepoRow } from '../repositories';
import { TimestampRepository } from '../repositories/timestamp-repository';
import { STAGE } from '../util/stage';

export type FillerFades = Record<string, number>;
export type FillerTimestamps = Map<string, Omit<TimestampRepoRow, 'hash'>>;

export const BLOCK_PER_FADE_SECS = 60 * 5; // 5 minutes

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
    const fillerHashes = webhookProvider.fillers();
    const fillerTimestamps = await timestampDB.getFillerTimestampsMap(fillerHashes);
    const addressToFillerHash = await webhookProvider.addressToFillerHash();

    // get fillers new fades from last checked timestamp:
    //  | rfqFiller    |     faded  |   postTimestamp  |
    //  |---- foo ------|---- 3 ----|---- 12345678 ----|
    //  |---- bar ------|---- 1 ----|---- 12222222 ----|
    const fillersNewFades = getFillersNewFades(result, addressToFillerHash, fillerTimestamps, log);

    const updatedTimestamps = calculateNewTimestamps(
      fillerTimestamps,
      fillersNewFades,
      Math.floor(Date.now() / 1000),
      log
    );
    log.info({ updatedTimestamps }, 'filler for which to update timestamp');
    await timestampDB.updateTimestampsBatch(updatedTimestamps);
  }
}

/* compute blockUntil timestamp for each filler
  blockedUntilTimestamp > current timestamp: skip
  lastPostTimestamp < blockedUntilTimestamp < current timestamp: block for # * unit block time from now
*/
export function calculateNewTimestamps(
  fillerTimestamps: FillerTimestamps,
  fillersNewFades: FillerFades,
  newPostTimestamp: number,
  log?: Logger
): [string, number, number][] {
  const updatedTimestamps: [string, number, number][] = [];
  fillerTimestamps.forEach((row, hash) => {
    if (row.blockUntilTimestamp > newPostTimestamp) {
      return;
    }
    const newFades = fillersNewFades[hash];
    if (newFades) {
      const blockUntilTimestamp = Math.floor(Date.now() / 1000) + newFades * BLOCK_PER_FADE_SECS;
      updatedTimestamps.push([hash, newPostTimestamp, blockUntilTimestamp]);
    }
  });
  log?.info({ updatedTimestamps }, 'updated timestamps');
  return updatedTimestamps;
}

export function getFillersNewFades(
  rows: FadesRowType[],
  addressToFillerHash: Map<string, string>,
  fillerTimestamps: FillerTimestamps,
  log?: Logger
): FillerFades {
  const newFadesMap: FillerFades = {}; // filler hash -> # of new fades
  rows.forEach((row) => {
    const fillerAddr = row.fillerAddress.toLowerCase();
    const fillerHash = addressToFillerHash.get(fillerAddr);
    if (!fillerHash) {
      log?.info({ fillerAddr }, 'filler address not found in webhook config');
    } else if (
      fillerTimestamps.has(fillerHash) &&
      row.postTimestamp > fillerTimestamps.get(fillerHash)!.lastPostTimestamp
    ) {
      if (!newFadesMap[fillerHash]) {
        newFadesMap[fillerHash] = row.faded;
      } else {
        newFadesMap[fillerHash] += row.faded;
      }
    }
  });
  log?.info({ newFadesMap }, '# of new fades by filler');
  return newFadesMap;
}
