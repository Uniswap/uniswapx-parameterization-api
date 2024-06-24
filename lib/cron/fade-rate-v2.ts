import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { metricScope, MetricsLogger, Unit } from 'aws-embedded-metrics';
import { ScheduledHandler } from 'aws-lambda/trigger/cloudwatch-events';
import { EventBridgeEvent } from 'aws-lambda/trigger/eventbridge';
import Logger from 'bunyan';

import { ethers } from 'ethers';
import { BETA_S3_KEY, PRODUCTION_S3_KEY, WEBHOOK_CONFIG_BUCKET } from '../constants';
import { CircuitBreakerMetricDimension, Metric, metricContext } from '../entities';
import { checkDefined } from '../preconditions/preconditions';
import { S3WebhookConfigurationProvider } from '../providers';
import {
  SharedConfigs,
  TimestampRepoRow,
  ToUpdateTimestampRow,
  V2FadesRepository,
  V2FadesRowType,
} from '../repositories';
import { DynamoFillerAddressRepository } from '../repositories/filler-address-repository';
import { TimestampRepository } from '../repositories/timestamp-repository';
import { STAGE } from '../util/stage';

export type FillerFades = Record<string, number>;
export type FillerTimestamps = Map<string, Omit<TimestampRepoRow, 'hash'>>;

export const BASE_BLOCK_SECS = 60 * 20; // 20 minutes
export const NUM_FADES_MULTIPLIER = 1.5;

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
    const fillerTimestamps = await timestampDB.getFillerTimestampsMap(fillerEndpoints);

    // get fillers new fades from last checked timestamp:
    //  | hash     |    faded  |   postTimestamp  |
    //  |---- foo -|---- 3 ----|---- 12345678 ----|
    //  |---- bar -|---- 1 ----|---- 12222222 ----|
    const fillersNewFades = getFillersNewFades(result, addressToFillerMap, fillerTimestamps, log);

    //  | hash        |lastPostTimestamp|blockUntilTimestamp|
    //  |---- foo ----|---- 1300000 ----|----      calculated block until  ----|
    //  |---- bar ----|---- 1300000 ----|----      13500000                ----|
    const updatedTimestamps = calculateNewTimestamps(
      fillerTimestamps,
      fillersNewFades,
      Math.floor(Date.now() / 1000),
      log,
      metrics
    );
    log.info({ updatedTimestamps }, 'filler for which to update timestamp');
    metrics.putMetric(Metric.CIRCUIT_BREAKER_V2_BLOCKED, updatedTimestamps.length, Unit.Count);
    if (updatedTimestamps.length > 0) {
      await timestampDB.updateTimestampsBatch(updatedTimestamps);
    } else {
      log.info('no timestamp to update');
    }
  }
}

function newConsecutiveBlocks(consecutiveBlocks?: number): number {
  if (!consecutiveBlocks) {
    return 1;
  }
  if (Number.isNaN(consecutiveBlocks)) {
    return 1;
  }
  return consecutiveBlocks + 1;
}

/* compute blockUntil timestamp for each filler
  blockedUntilTimestamp > current timestamp: skip
  lastPostTimestamp < blockedUntilTimestamp < current timestamp: block for # * unit block time from now
  increment consecutive blocks afterwards
*/
export function calculateNewTimestamps(
  fillerTimestamps: FillerTimestamps,
  fillersNewFades: FillerFades,
  newPostTimestamp: number,
  log?: Logger,
  metrics?: MetricsLogger
): ToUpdateTimestampRow[] {
  const updatedTimestamps: ToUpdateTimestampRow[] = [];
  Object.entries(fillersNewFades).forEach((row) => {
    const hash = row[0];
    const fades = row[1];
    const fillerTimestamp = fillerTimestamps.get(hash);
    if (fillerTimestamp && fillerTimestamp.blockUntilTimestamp > newPostTimestamp) {
      return;
    }
    if (fades) {
      const blockUntilTimestamp = calculateBlockUntilTimestamp(
        newPostTimestamp,
        fillerTimestamp?.consecutiveBlocks,
        fades
      );
      const consecutiveBlocks = newConsecutiveBlocks(fillerTimestamp?.consecutiveBlocks);
      metrics?.putMetric(
        metricContext(Metric.CIRCUIT_BREAKER_V2_CONSECUTIVE_BLOCKS, hash),
        consecutiveBlocks,
        Unit.Count
      );

      updatedTimestamps.push({
        hash,
        lastPostTimestamp: newPostTimestamp,
        blockUntilTimestamp,
        consecutiveBlocks: consecutiveBlocks,
      });
    } else {
      // no new fades, reset consecutive blocks
      updatedTimestamps.push({
        hash,
        lastPostTimestamp: newPostTimestamp,
        blockUntilTimestamp: newPostTimestamp,
        consecutiveBlocks: 0,
      });
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
  log?.info(
    {
      rows: rows,
      fillerTimestamps: [...fillerTimestamps.entries()],
      addressToFillerMap: [...addressToFillerMap.entries()],
    },
    'getFillersNewFades'
  );
  const newFadesMap: FillerFades = {}; // filler hash -> # of new fades
  rows.forEach((row) => {
    const fillerAddr = ethers.utils.getAddress(row.fillerAddress);
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

/*
  calculate the block until timestamp with exponential backoff
  if a filler faded multiple times in between the last post timestamp and now,
    we apply a 1.5 multiplier for each fade
    
    examples:
    - 1 fade, 0 consecutive blocks: 20 minutes
    - 1 fade, 1 consecutive blocks:  (1.5 ^ 0) * 20 * 2^1 = 40 minutes
    - 1 fade, 2 consecutive blocks:  (1.5 ^ 0) * 20 * 2^2 = 80 minutes
    - 1 fade, 3 consecutive blocks:  (1.5 ^ 0) * 20 * 2^3 = 160 minutes
    - 2 fades, 0 consecutive blocks: (1.5 ^ 1) * 20 * 2^0 = 30 minutes
    - 2 fades 1 consecutive blocks:  (1.5 ^ 1) * 20 * 2^1 = 60 minutes
    - 2 fades 2 consecutive blocks:  (1.5 ^ 1) * 20 * 2^2 = 120 minute
    - 3 fades 0 consecutive blocks:  (1.5 ^ 2) * 20 * 2^0 = 45 minutes
    - 3 fades 1 consecutive blocks:  (1.5 ^ 2) * 20 * 2^1 = 90 minutes
    - 3 fades 2 consecutive blocks:  (1.5 ^ 2) * 20 * 2^2 = 180 minutes
*/
export function calculateBlockUntilTimestamp(
  newPostTimestamp: number,
  consecutiveBlocks: number | undefined,
  fades: number
): number {
  const blocks = consecutiveBlocks || 0;
  return Math.floor(
    newPostTimestamp + BASE_BLOCK_SECS * Math.pow(NUM_FADES_MULTIPLIER, fades - 1) * Math.pow(2, blocks)
  );
}
