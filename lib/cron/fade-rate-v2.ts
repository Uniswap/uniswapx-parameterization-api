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
import { TimestampRepository, UNBLOCKED_BLOCK_UNTIL_TIMESTAMP } from '../repositories/timestamp-repository';
import { STAGE } from '../util/stage';

// Re-exported for existing importers; the sentinel lives with the repository that owns the
// stored value's parse/write semantics.
export { UNBLOCKED_BLOCK_UNTIL_TIMESTAMP };

export type FillerFadeStats = {
  // Laplace-smoothed fade rate over the filler's post-block window (see getFillersFadeStats).
  // The underlying query bounds the window to 24 hours OR the latest ORDERS_PER_FILLER_LIMIT
  // orders, whichever is smaller — so high-volume fillers are judged on recent orders (fast
  // acute response) and low-volume fillers on up to a full day (catches chronic fading).
  fadeRate: number;
  // Laplace-smoothed fade rate over orders that completed since the last cron run with a
  // deadline on/before the filler's block end — i.e. orders in flight during a block.
  // Used to extend an active block (or re-block right after expiry). Rate-based so clean
  // in-flight fills offset stray fades: extending a block is volume-neutral, just like
  // tripping one.
  duringBlockRate: number;
  // Orders completed since the last cron run (any cohort). Gates consecutiveBlocks decay:
  // working off escalation requires demonstrated activity, not just going idle while stale
  // rows linger in the 24h view.
  newCompletions: number;
};
export type FillerFadeStatsMap = Record<string, FillerFadeStats>;
export type FillerTimestamps = Map<string, Omit<TimestampRepoRow, 'hash'>>;

export const BASE_BLOCK_SECS = 60 * 15; // 15 minutes

// Laplace (additive) smoothing applied to each filler's fade rate so a few fades on a
// small sample don't trip the breaker. Equivalent to seeding every filler with ALPHA
// pretend-fades and BETA pretend-clean-fills. Prior mean = ALPHA/(ALPHA+BETA) = 1/20 = 5%.
export const LAPLACE_ALPHA = 1;
export const LAPLACE_BETA = 19;
// Block a filler once their smoothed fade rate exceeds this. Must be greater than the prior
// mean (5%), else the prior alone would block every filler. At 12% a filler trips at roughly
// a sustained ~14%+ raw fade rate (e.g. ~3 fades in 10, ~14 in 100), or ~2 fades at very low
// volume.
export const FADE_RATE_BLOCK_THRESHOLD = 0.12;

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
const timestampDB = TimestampRepository.create();

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

    // compute each filler's Laplace-smoothed fade rates (post-block window + during-block cohort):
    //  | hash     |  fadeRate  |  duringBlockRate  |
    //  |---- foo -|---- 0.18 --|------ 0.05 -------|
    //  |---- bar -|---- 0.05 --|------ 0.20 -------|
    const fillerFadeStats = getFillersFadeStats(result, addressToFillerMap, fillerTimestamps, log);

    //  | hash        |lastExaminedTimestamp|blockUntilTimestamp|fadeWindowStart|
    //  |---- foo ----|---- 1300000 ----|----      calculated block until  ----|
    //  |---- bar ----|---- 1300000 ----|----      13500000                ----|
    const now = Math.floor(Date.now() / 1000);
    const updatedTimestamps = calculateNewTimestamps(fillerTimestamps, fillerFadeStats, now, log, metrics);
    log.info({ updatedTimestamps }, 'filler for which to update timestamp');
    metrics.putMetric(Metric.CIRCUIT_BREAKER_V2_BLOCKED, updatedTimestamps.length, Unit.Count);
    metrics.putMetric(
      Metric.CIRCUIT_BREAKER_V2_ACTIVE_BLOCKS,
      countActiveBlocks(fillerTimestamps, updatedTimestamps, now),
      Unit.Count
    );
    metrics.putMetric(Metric.CIRCUIT_BREAKER_V2_FILLERS_EVALUATED, Object.keys(fillerFadeStats).length, Unit.Count);
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
    - In-flight orders faded at over the threshold rate while blocked: EXTEND the block
      from current blockUntil and increment consecutiveBlocks
    - Otherwise: keep existing block (don't decay while blocked)
  If not blocked:
    - Post-block fade rate over threshold — or the during-block cohort over threshold
      (late in-flight fades from a block that expired between cron runs): block,
      increment consecutiveBlocks
    - Otherwise: reset blockUntilTimestamp to unblocked and decay consecutiveBlocks by 1 —
      but only if the filler completed new orders since the last run (idling must not work
      off escalation). fadeWindowStart is left untouched so the clean-slate floor persists.

  blockUntilTimestamp is the block expiry (used for the is-blocked check). fadeWindowStart is
  the clean-slate floor for the fade-rate window; a block/extension sets both to the block end,
  so while blocked the floor is in the future (window empty) and after expiry it is the past
  block end (a returning filler is scored only on orders completed after their block ended).
*/
export function calculateNewTimestamps(
  fillerTimestamps: FillerTimestamps,
  fillerFadeStats: FillerFadeStatsMap,
  newPostTimestamp: number,
  log?: Logger,
  metrics?: MetricsLogger
): ToUpdateTimestampRow[] {
  const updatedTimestamps: ToUpdateTimestampRow[] = [];
  let newBlocks = 0;
  let extendedBlocks = 0;
  Object.entries(fillerFadeStats).forEach(([hash, stats]) => {
    const { fadeRate, duringBlockRate, newCompletions } = stats;
    const fillerTimestamp = fillerTimestamps.get(hash);
    const isCurrentlyBlocked = fillerTimestamp && fillerTimestamp.blockUntilTimestamp > newPostTimestamp;
    const previousBlocks = fillerTimestamp?.consecutiveBlocks || 0;

    // Per-filler rate so the distribution can be charted against FADE_RATE_BLOCK_THRESHOLD. While
    // blocked, fadeRate sits at the prior (post-block window is empty), so also emit the
    // during-block rate — the signal that actually drives extend/re-block — to chart benched
    // fillers against the same threshold.
    metrics?.putMetric(metricContext(Metric.CIRCUIT_BREAKER_V2_FADE_RATE, hash), fadeRate, Unit.None);
    if (isCurrentlyBlocked) {
      metrics?.putMetric(metricContext(Metric.CIRCUIT_BREAKER_V2_DURING_BLOCK_RATE, hash), duringBlockRate, Unit.None);
    }

    // Resulting escalation level for this filler, emitted once below so the dashboard can chart
    // climbs, plateaus, and decay back to 0 (not just the block/extend steps).
    let consecutiveBlocks: number;

    if (isCurrentlyBlocked && duringBlockRate > FADE_RATE_BLOCK_THRESHOLD) {
      // In-flight orders faded at over the threshold rate while blocked: stack the penalty,
      // extending from the current block end. Rate-based, so a high-volume filler's stray
      // in-flight fade offset by clean in-flight fills does not extend the block.
      const extendedBlockUntil = calculateBlockUntilTimestamp(
        fillerTimestamp.blockUntilTimestamp, // Extend from when current block ends
        fillerTimestamp.consecutiveBlocks
      );
      consecutiveBlocks = newConsecutiveBlocks(fillerTimestamp.consecutiveBlocks);

      extendedBlocks++;
      log?.info(
        { hash, currentBlockUntil: fillerTimestamp.blockUntilTimestamp, extendedBlockUntil, duringBlockRate },
        'Extending block for filler who faded while blocked'
      );

      updatedTimestamps.push({
        hash,
        lastExaminedTimestamp: newPostTimestamp,
        blockUntilTimestamp: extendedBlockUntil,
        fadeWindowStart: extendedBlockUntil, // clean slate resumes when the extended block ends
        consecutiveBlocks,
      });
    } else if (isCurrentlyBlocked) {
      // Blocked but no new fades - keep existing block and floor, don't decay
      consecutiveBlocks = fillerTimestamp.consecutiveBlocks;
      updatedTimestamps.push({
        hash,
        lastExaminedTimestamp: newPostTimestamp,
        blockUntilTimestamp: fillerTimestamp.blockUntilTimestamp,
        fadeWindowStart: fillerTimestamp.fadeWindowStart,
        consecutiveBlocks,
      });
    } else if (fadeRate > FADE_RATE_BLOCK_THRESHOLD || duringBlockRate > FADE_RATE_BLOCK_THRESHOLD) {
      // duringBlockRate covers in-flight fades that landed near the end of a block that
      // expired between cron runs: they sit below the clean-slate floor, so this is the only
      // path that scores them. Over the rolling 24h window a filler can also cross the
      // threshold on a run with no new completions ("blocked while idle") as clean orders age
      // out; that is accepted behavior.
      const blockUntilTimestamp = calculateBlockUntilTimestamp(newPostTimestamp, fillerTimestamp?.consecutiveBlocks);
      consecutiveBlocks = newConsecutiveBlocks(fillerTimestamp?.consecutiveBlocks);

      newBlocks++;
      log?.info(
        { hash, fadeRate, duringBlockRate, blockUntilTimestamp },
        'Blocking filler for exceeding fade rate threshold'
      );

      updatedTimestamps.push({
        hash,
        lastExaminedTimestamp: newPostTimestamp,
        blockUntilTimestamp,
        fadeWindowStart: blockUntilTimestamp, // clean slate resumes when the block ends
        consecutiveBlocks,
      });
    } else {
      // Under threshold: not blocked. Reset blockUntilTimestamp to unblocked and decay
      // consecutiveBlocks by 1 (gradual decay resists gaming via alternating fade/clean
      // cycles). Decay only when the filler completed new orders this run, so working off
      // escalation requires demonstrated clean activity rather than idling. fadeWindowStart
      // is left as-is: it holds the last block end as the clean-slate floor, so a returning
      // filler is scored only on orders completed after their block ended.
      consecutiveBlocks = newCompletions > 0 ? Math.max(0, previousBlocks - 1) : previousBlocks;
      updatedTimestamps.push({
        hash,
        lastExaminedTimestamp: newPostTimestamp,
        blockUntilTimestamp: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
        fadeWindowStart: fillerTimestamp?.fadeWindowStart ?? UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
        consecutiveBlocks,
      });
    }

    // Emit the escalation level whenever the filler is or was escalated, so the chart steps
    // down through decay and plots the 0 when a filler fully recovers. Skip never-blocked
    // fillers (0 -> 0) to avoid a flat-zero series per filler.
    if (consecutiveBlocks > 0 || previousBlocks > 0) {
      metrics?.putMetric(metricContext(Metric.CIRCUIT_BREAKER_V2_CONSECUTIVE_BLOCKS, hash), consecutiveBlocks, Unit.Count);
    }
  });
  metrics?.putMetric(Metric.CIRCUIT_BREAKER_V2_NEW_BLOCKS, newBlocks, Unit.Count);
  metrics?.putMetric(Metric.CIRCUIT_BREAKER_V2_EXTENDED_BLOCKS, extendedBlocks, Unit.Count);
  log?.info({ updatedTimestamps, newBlocks, extendedBlocks }, 'updated timestamps');
  return updatedTimestamps;
}

/* Number of fillers benched (blockUntilTimestamp in the future) after applying this run's
   updates on top of stored state. Includes benched fillers with no completions this run —
   they produce no stats row, but their stored block is still active. */
export function countActiveBlocks(
  fillerTimestamps: FillerTimestamps,
  updatedTimestamps: ToUpdateTimestampRow[],
  now: number
): number {
  const effectiveBlockUntil = new Map<string, number>();
  fillerTimestamps.forEach((row, hash) =>
    effectiveBlockUntil.set(hash, row.blockUntilTimestamp ?? UNBLOCKED_BLOCK_UNTIL_TIMESTAMP)
  );
  updatedTimestamps.forEach((row) =>
    effectiveBlockUntil.set(row.hash, row.blockUntilTimestamp ?? UNBLOCKED_BLOCK_UNTIL_TIMESTAMP)
  );
  return [...effectiveBlockUntil.values()].filter((blockUntil) => blockUntil > now).length;
}

/* Laplace-smoothed fade rate: pretend we've already seen LAPLACE_ALPHA fades and
   LAPLACE_BETA clean fills, so small samples are pulled toward the prior mean instead
   of swinging to 0% or 100%. */
export function laplaceSmoothedFadeRate(fades: number, total: number): number {
  return (fades + LAPLACE_ALPHA) / (total + LAPLACE_ALPHA + LAPLACE_BETA);
}

/* Compute, per filler, Laplace-smoothed fade rates over two disjoint cohorts.
   @param rows: info about individual orders: filler address, faded or not, deadline (completion time)
   @param fillerTimestamps: last checked timestamp and block until timestamp for each filler
   @param addressToFillerMap: map of address to filler hash

   - fadeRate: orders whose deadline is after the filler's fadeWindowStart (last block end)
     ("post-block window"). This is the clean-slate mechanism: a filler who served a block
     is scored only on orders completed after the block ended, not on the pre-block fades
     that are still inside the query's rolling window. While a filler is currently blocked
     the floor is in the future, so this window is ~empty and the rate sits at the prior.
   - duringBlockRate: orders completed since the last cron run with deadline on/before the
     block end — i.e. orders that were in flight during a block. calculateNewTimestamps uses
     this to extend an active block, or to re-block right after expiry so late in-flight
     fades can't slip between two cron runs. Scored per cron-run slice: a blocked filler
     trickling isolated fades (each slice under threshold) won't extend the block, but those
     orders never enter the post-block window either — they still serve the full bench.

   NOTE: cohort membership uses `deadline` (order completion time) instead of `postTimestamp`.
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
  const tallies: Record<
    string,
    { windowFades: number; windowTotal: number; blockFades: number; blockTotal: number; newCompletions: number }
  > = {};
  rows.forEach((row) => {
    const fillerAddr = ethers.utils.getAddress(row.fillerAddress);
    const fillerHash = addressToFillerMap.get(fillerAddr);
    if (!fillerHash) {
      log?.info({ fillerAddr }, 'filler address not found dynamo mapping');
      return;
    }
    const fillerTimestamp = fillerTimestamps.get(fillerHash);
    if (!tallies[fillerHash]) {
      tallies[fillerHash] = { windowFades: 0, windowTotal: 0, blockFades: 0, blockTotal: 0, newCompletions: 0 };
    }
    const windowStart = fillerTimestamp?.fadeWindowStart ?? UNBLOCKED_BLOCK_UNTIL_TIMESTAMP;
    const lastExaminedTimestamp = fillerTimestamp?.lastExaminedTimestamp ?? 0;
    if (row.deadline > lastExaminedTimestamp) {
      tallies[fillerHash].newCompletions += 1;
    }
    if (row.deadline > windowStart) {
      // Rate window: orders completed after the filler's last block ended (clean slate).
      tallies[fillerHash].windowTotal += 1;
      tallies[fillerHash].windowFades += row.faded;
    } else if (row.deadline > lastExaminedTimestamp) {
      // During-block cohort: completed since the last cron run but on/before the block end,
      // i.e. in flight during the block. Never overlaps the rate window (deadline <= floor),
      // so during-block orders stay excluded from the post-block clean slate.
      tallies[fillerHash].blockTotal += 1;
      tallies[fillerHash].blockFades += row.faded;
    }
  });

  const stats: FillerFadeStatsMap = {};
  Object.entries(tallies).forEach(([hash, t]) => {
    stats[hash] = {
      fadeRate: laplaceSmoothedFadeRate(t.windowFades, t.windowTotal),
      duringBlockRate: laplaceSmoothedFadeRate(t.blockFades, t.blockTotal),
      newCompletions: t.newCompletions,
    };
  });
  log?.info({ tallies, stats }, 'fade stats by filler');
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
