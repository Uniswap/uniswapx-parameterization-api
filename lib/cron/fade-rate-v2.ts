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
import { SharedConfigs, TimestampRepoRow, V2FadesRepository, V2FadesRowType } from '../repositories';
import { DynamoFillerAddressRepository } from '../repositories/filler-address-repository';
import { TimestampRepository } from '../repositories/timestamp-repository';
import { STAGE } from '../util/stage';

export type FillerFades = Record<string, number>;
export type FillerTimestamps = Map<string, Omit<TimestampRepoRow, 'hash'>>;

export const BLOCK_PER_FADE_SECS = 60 * 5; // 5 minutes

const log = Logger.createLogger({
  name: 'FadeRate',
  serializers: Logger.stdSerializers,
});

/* set up aws clients */
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
const fillerAddressRepo = DynamoFillerAddressRepository.create(documentClient);
const timestampDB = TimestampRepository.create(documentClient);

export const handler: ScheduledHandler = metricScope((metrics) => async (_event: EventBridgeEvent<string, void>) => {
  await main(metrics);
});

async function main(metrics: MetricsLogger) {
  metrics.setNamespace('Uniswap');
  metrics.setDimensions(CircuitBreakerMetricDimension);

  const sharedConfig: SharedConfigs = {
    Database: checkDefined(process.env.REDSHIFT_DATABASE),
    ClusterIdentifier: checkDefined(process.env.REDSHIFT_CLUSTER_IDENTIFIER),
    SecretArn: checkDefined(process.env.REDSHIFT_SECRET_ARN),
  };
  const fadesRepository = V2FadesRepository.create(sharedConfig);
  await fadesRepository.createFadesView();
  await webhookProvider.fetchEndpoints();
  /*
   query redshift for recent orders
        | fillerAddress |    faded  |   postTimestamp |
        |---- 0x1 ------|---- 0 ----|---- 12222222 ---|
        |---- 0x2 ------|---- 1 ----|---- 12345679 --|
        |---- 0x1 ------|---- 0 ----|---- 12345678 ---|
  */
  const result = await fadesRepository.getFades();

  if (result) {
    const fillerEndpoints = webhookProvider.fillerEndpoints();
    const addressToFillerMap = await fillerAddressRepo.getAddressToFillerMap(fillerEndpoints);
    log.info({ addressToFillerMap }, 'address to filler map from dynamo');
    const fillerTimestamps = await timestampDB.getFillerTimestampsMap(fillerEndpoints);

    // get fillers new fades from last checked timestamp:
    //  | hash    |     faded  |   postTimestamp  |
    //  |---- foo ------|---- 3 ----|---- 12345678 ----|
    //  |---- bar ------|---- 1 ----|---- 12222222 ----|
    const fillersNewFades = getFillersNewFades(result, addressToFillerMap, fillerTimestamps, log);

    //  | hash        |lastPostTimestamp|blockUntilTimestamp|
    //  |---- foo ----|---- 1300000 ----|---- now + fades * block_per_fade ----|
    //  |---- bar ----|---- 1300000 ----|----      13500000                ----|
    const updatedTimestamps = calculateNewTimestamps(
      fillerTimestamps,
      fillersNewFades,
      Math.floor(Date.now() / 1000),
      log
    );
    log.info({ updatedTimestamps }, 'filler for which to update timestamp');
    if (updatedTimestamps.length > 0) {
      await timestampDB.updateTimestampsBatch(updatedTimestamps);
    } else {
      log.info('no timestamp to update');
    }
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
  Object.entries(fillersNewFades).forEach((row) => {
    const hash = row[0];
    const fades = row[1];
    if (fillerTimestamps.has(hash) && fillerTimestamps.get(hash)!.blockUntilTimestamp > newPostTimestamp) {
      return;
    }
    if (fades) {
      const blockUntilTimestamp = newPostTimestamp + fades * BLOCK_PER_FADE_SECS;
      updatedTimestamps.push([hash, newPostTimestamp, blockUntilTimestamp]);
    }
  });
  log?.info({ updatedTimestamps }, 'updated timestamps');
  return updatedTimestamps;
}

/* find the number of new fades, for each filler entity, from 
   the last time this cron is run
   @param rows: info about individual orders: filler address, faded or not, post timestamp
   @param fillerTimestamps: last post timestamp and block until timestamp for each filler
   @param addressToFillerMap: map of address to filler hash
*/
export function getFillersNewFades(
  rows: V2FadesRowType[],
  addressToFillerMap: Map<string, string>,
  fillerTimestamps: FillerTimestamps,
  log?: Logger
): FillerFades {
  const newFadesMap: FillerFades = {}; // filler hash -> # of new fades
  rows.forEach((row) => {
    const fillerAddr = row.fillerAddress.toLowerCase();
    const fillerHash = addressToFillerMap.get(fillerAddr);
    if (!fillerHash) {
      log?.info({ fillerAddr }, 'filler address not found dynamo mapping');
    } else if (
      (fillerTimestamps.has(fillerHash) && row.postTimestamp > fillerTimestamps.get(fillerHash)!.lastPostTimestamp) ||
      !fillerTimestamps.has(fillerHash)
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
