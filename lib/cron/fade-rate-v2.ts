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

export type FillerFadeStats = {
  // Laplace-smoothed fade rate over the filler's post-block window (see getFillersFadeStats).
  fadeRate: number;
  // Orders that faded since the last cron run; used to stack penalties while already blocked.
  newFades: number;
};
export type FillerFadeStatsMap = Record<string, FillerFadeStats>;
export type FillerTimestamps = Map<string, Omit<TimestampRepoRow, 'hash'>>;

export const BASE_BLOCK_SECS = 60 * 15; // 15 minutes

// Laplace (additive) smoothing applied to each filler's fade rate so a few fades on a
// small sample don't trip the breaker. Equivalent to seeding every filler with ALPHA
// pretend-fades and BETA pretend-clean-fills. Prior mean = ALPHA/(ALPHA+BETA) ≈ 4.8%.
export const LAPLACE_ALPHA = 1;
export const LAPLACE_BETA = 20;
// Block a filler once their smoothed fade rate exceeds this. MUST be greater than the
// prior mean (~4.8%), otherwise the prior alone would block every filler.
// At this threshold a filler needs e.g. ~3 fades in 10 orders, ~4 in 20, ~8 in 50.
export const FADE_RATE_BLOCK_THRESHOLD = 0.12;

/** Sentinel when the filler has no active block (always < now for real unix seconds). Avoids equaling lastPostTimestamp, which could briefly read as blocked under clock skew. */
export const UNBLOCKED_BLOCK_UNTIL_TIMESTAMP = 0;

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

    // compute each filler's Laplace-smoothed fade rate (and new fades since last run):
    //  | hash     |  fadeRate  |  newFades  |
    //  |---- foo -|---- 0.18 --|---- 3 -----|
    //  |---- bar -|---- 0.05 --|---- 0 -----|
    const fillerFadeStats = getFillersFadeStats(result, addressToFillerMap, fillerTimestamps, log);

    //  | hash        |lastPostTimestamp|blockUntilTimestamp|
    //  |---- foo ----|---- 1300000 ----|----      calculated block until  ----|
    //  |---- bar ----|---- 1300000 ----|----      13500000                ----|
    const updatedTimestamps = calculateNewTimestamps(
      fillerTimestamps,
      fillerFadeStats,
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
  If currently blocked:
    - With new fades (in-flight orders that faded while blocked): EXTEND the block from
      current blockUntil and increment consecutiveBlocks
    - Without new fades: keep existing block (don't decay while blocked)
  If not blocked:
    - Fade rate over threshold: block, increment consecutiveBlocks
    - Fade rate under threshold: decay consecutiveBlocks by 1, and KEEP the (now past)
      blockUntilTimestamp so it remains the clean-slate floor for the rate window
*/
export function calculateNewTimestamps(
  fillerTimestamps: FillerTimestamps,
  fillerFadeStats: FillerFadeStatsMap,
  newPostTimestamp: number,
  log?: Logger,
  metrics?: MetricsLogger
): ToUpdateTimestampRow[] {
  const updatedTimestamps: ToUpdateTimestampRow[] = [];
  Object.entries(fillerFadeStats).forEach(([hash, stats]) => {
    const { fadeRate, newFades } = stats;
    const fillerTimestamp = fillerTimestamps.get(hash);
    const isCurrentlyBlocked = fillerTimestamp && fillerTimestamp.blockUntilTimestamp > newPostTimestamp;

    if (isCurrentlyBlocked && newFades > 0) {
      // Faded again on in-flight orders while blocked: stack the penalty.
      // Extend the block from current blockUntil, not from now.
      const extendedBlockUntil = calculateBlockUntilTimestamp(
        fillerTimestamp.blockUntilTimestamp, // Extend from when current block ends
        fillerTimestamp.consecutiveBlocks
      );
      const consecutiveBlocks = newConsecutiveBlocks(fillerTimestamp.consecutiveBlocks);

      log?.info(
        { hash, currentBlockUntil: fillerTimestamp.blockUntilTimestamp, extendedBlockUntil, newFades },
        'Extending block for filler who faded while blocked'
      );
      metrics?.putMetric(
        metricContext(Metric.CIRCUIT_BREAKER_V2_CONSECUTIVE_BLOCKS, hash),
        consecutiveBlocks,
        Unit.Count
      );

      updatedTimestamps.push({
        hash,
        lastPostTimestamp: newPostTimestamp,
        blockUntilTimestamp: extendedBlockUntil,
        consecutiveBlocks,
      });
    } else if (isCurrentlyBlocked) {
      // Blocked but no new fades - keep existing block, don't decay
      updatedTimestamps.push({
        hash,
        lastPostTimestamp: newPostTimestamp,
        blockUntilTimestamp: fillerTimestamp.blockUntilTimestamp,
        consecutiveBlocks: fillerTimestamp.consecutiveBlocks,
      });
    } else if (fadeRate > FADE_RATE_BLOCK_THRESHOLD) {
      const blockUntilTimestamp = calculateBlockUntilTimestamp(newPostTimestamp, fillerTimestamp?.consecutiveBlocks);
      const consecutiveBlocks = newConsecutiveBlocks(fillerTimestamp?.consecutiveBlocks);

      log?.info({ hash, fadeRate, blockUntilTimestamp }, 'Blocking filler for exceeding fade rate threshold');
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
      // Under threshold: decay consecutiveBlocks gradually instead of resetting (prevents
      // gaming via alternating fade/clean cycles). Preserve the existing (now past)
      // blockUntilTimestamp: it's the clean-slate floor so a returning filler is scored
      // only on orders completed after their last block ended.
      const decayedBlocks = Math.max(0, (fillerTimestamp?.consecutiveBlocks || 0) - 1);
      updatedTimestamps.push({
        hash,
        lastPostTimestamp: newPostTimestamp,
        blockUntilTimestamp: fillerTimestamp?.blockUntilTimestamp ?? UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
        consecutiveBlocks: decayedBlocks,
      });
    }
  });
  log?.info({ updatedTimestamps }, 'updated timestamps');
  return updatedTimestamps;
}

/* Laplace-smoothed fade rate: pretend we've already seen LAPLACE_ALPHA fades and
   LAPLACE_BETA clean fills, so small samples are pulled toward the prior mean instead
   of swinging to 0% or 100%. */
export function laplaceSmoothedFadeRate(fades: number, total: number): number {
  return (fades + LAPLACE_ALPHA) / (total + LAPLACE_ALPHA + LAPLACE_BETA);
}

/* Compute, per filler, the Laplace-smoothed fade rate and the number of fades since
   the last cron run.
   @param rows: info about individual orders: filler address, faded or not, deadline (completion time)
   @param fillerTimestamps: last checked timestamp and block until timestamp for each filler
   @param addressToFillerMap: map of address to filler hash

   The fade rate is computed over the filler's "post-block window" — orders whose deadline
   is after their last blockUntilTimestamp. This is the clean-slate mechanism: a filler who
   served a block is scored only on orders completed after the block ended, not on the
   pre-block fades that are still inside the query's rolling window. While a filler is
   currently blocked the floor is in the future, so windowTotal is ~0 and the rate sits at
   the prior — only newFades (used by calculateNewTimestamps) can extend an active block.

   NOTE: We use `deadline` (order completion time) instead of `postTimestamp` for newFades.
   This ensures orders posted before the last cron run but completed after are still counted,
   preventing the "in-flight orders" exploit.
*/
export function getFillersFadeStats(
  rows: V2FadesRowType[],
  addressToFillerMap: Map<string, string>,
  fillerTimestamps: FillerTimestamps,
  log?: Logger
): FillerFadeStatsMap {
  log?.info(
    {
      rows: rows,
      fillerTimestamps: [...fillerTimestamps.entries()],
      addressToFillerMap: [...addressToFillerMap.entries()],
    },
    'getFillersFadeStats'
  );
  // filler hash -> tallies used to derive the stats below
  const tallies: Record<string, { windowFades: number; windowTotal: number; newFades: number }> = {};
  rows.forEach((row) => {
    const fillerAddr = ethers.utils.getAddress(row.fillerAddress);
    const fillerHash = addressToFillerMap.get(fillerAddr);
    if (!fillerHash) {
      log?.info({ fillerAddr }, 'filler address not found dynamo mapping');
      return;
    }
    const fillerTimestamp = fillerTimestamps.get(fillerHash);
    if (!tallies[fillerHash]) {
      tallies[fillerHash] = { windowFades: 0, windowTotal: 0, newFades: 0 };
    }
    // Rate window: orders completed after the filler's last block ended (clean slate).
    const windowStart = fillerTimestamp?.blockUntilTimestamp ?? UNBLOCKED_BLOCK_UNTIL_TIMESTAMP;
    if (row.deadline > windowStart) {
      tallies[fillerHash].windowTotal += 1;
      tallies[fillerHash].windowFades += row.faded;
    }
    // New fades since the last cron run (deadline-based; catches in-flight orders).
    if (!fillerTimestamp || row.deadline > fillerTimestamp.lastPostTimestamp) {
      tallies[fillerHash].newFades += row.faded;
    }
  });

  const stats: FillerFadeStatsMap = {};
  Object.entries(tallies).forEach(([hash, t]) => {
    stats[hash] = {
      fadeRate: laplaceSmoothedFadeRate(t.windowFades, t.windowTotal),
      newFades: t.newFades,
    };
  });
  log?.info({ stats }, 'fade stats by filler');
  return stats;
}

/*
  calculate the block until timestamp with exponential backoff on consecutive blocks.
  Block length depends only on how many times the filler has been blocked in a row, not
  on the absolute fade count, so high-volume fillers aren't penalized for volume.

    examples (BASE_BLOCK_SECS = 15 min):
    - 0 consecutive blocks: 15 * 2^0 = 15 minutes
    - 1 consecutive block:  15 * 2^1 = 30 minutes
    - 2 consecutive blocks: 15 * 2^2 = 60 minutes
    - 3 consecutive blocks: 15 * 2^3 = 120 minutes
*/
export function calculateBlockUntilTimestamp(fromTimestamp: number, consecutiveBlocks: number | undefined): number {
  const blocks = consecutiveBlocks || 0;
  return Math.floor(fromTimestamp + BASE_BLOCK_SECS * Math.pow(2, blocks));
}
