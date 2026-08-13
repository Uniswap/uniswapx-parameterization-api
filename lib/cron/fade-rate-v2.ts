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
  ORDERS_PER_FILLER_LIMIT,
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
  // Completions newly classified this run (see the finality-lagged slice in
  // getFillersFadeStats) whose deadline is past the clean-slate floor. Gates consecutiveBlocks
  // decay: working off escalation requires demonstrated post-block activity — idling doesn't
  // count, and neither do fills that were merely in flight while serving a bench.
  newCompletions: number;
  // Fades newly classified this run, from ANY cohort (a during-bench fade is still a fade).
  // A run with any new fade is not a clean run: it cannot build the decay streak (and resets
  // it), so a sub-threshold fade never counts as recovery.
  newFades: number;
  // Raw (unsmoothed) fade rate over the FINAL rows of the filler's query window (24h /
  // latest-100 per address, deadline past the finality horizon), ignoring the clean-slate
  // floor — the no-amnesty "chronic" view. Final rows only, so not-yet-loaded fills can't
  // inflate the rate with transient fades. Never used for blocking: emitted as a watchlist
  // metric so persistent moderate faders who live inside the block threshold's envelope
  // (~0.12n + 1.4 fades per day, e.g. ~20% raw at 15 orders/day) stay visible to humans even
  // though the breaker correctly never trips on them.
  chronicRate: number;
  // Sample size behind chronicRate; the metric is only emitted at CHRONIC_RATE_MIN_SAMPLE+.
  chronicTotal: number;
  // How many of this filler's addresses have a query window that no longer reaches back to
  // the streak finality horizon: the address returned the full latest-N cap AND its oldest
  // returned row is fresher than STREAK_FINALITY_LAG_SECS. Rows for such an address are
  // being evicted before they can ever be streak-classified, thinning decay credit. (Merely
  // being at the latest-N cap is the designed adaptive window and is NOT flagged — big
  // fillers sit at the cap constantly.) Surfaced as an aggregate metric so per-address
  // volume outgrowing the window shows on the dashboard instead of as a stuck recovery.
  saturatedAddresses: number;
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
// Escalation (consecutiveBlocks) decays one level only after this many consecutive clean
// runs — cron runs whose newly classified slice has at least one post-floor completion and
// zero new fades. A run with any new fade resets the streak; an idle run freezes it. At the
// 10-minute cron cadence this makes recovery cost >=1 hour of demonstrated clean activity
// per level, so decay is structurally slower than escalation (+1 per block event). Without
// the streak, a chronic low-volume fader whose fades land in separate cron runs (fade #1
// under threshold -> "activity" decay, fade #2 -> block) nets zero escalation per cycle and
// stays on 15-30 minute blocks forever.
export const CLEAN_RUNS_PER_DECAY = 6;
// The streak classifies rows as "new" against a horizon that trails wall clock by this lag,
// because postedorders/archivedorders are batch-loaded (hourly) while the cron runs every 10
// minutes. Without the lag, streak classification is wrong in both directions: a fade whose
// row loads late (deadline already behind the watermark) never resets the streak, and an
// order whose fill row hasn't loaded yet reads as a transient fade (LEFT JOIN fillTimestamp
// NULL) exactly when it counts as new — resetting an honest filler's streak with no later
// correction. Rows older than the lag have final load state, so classification is exact.
// 2h = hourly load cadence + headroom for cross-table skew and job runtime.
//
// Known boundary (by design): a row is only classifiable while it survives in the query's
// latest-ORDERS_PER_FILLER_LIMIT window per address, so streak classification degrades for
// an address completing more than ORDERS_PER_FILLER_LIMIT orders per lag period (~50/hour
// sustained) — evicted rows are never classified, thinning streak credit (and, in the
// extreme, freezing decay). The 2-week backtest showed only the two busiest, never-escalated
// addresses touch this (peak 2h bursts at 104-123% of the cap; 0.6% of all rows evicted
// pre-classification, zero behavioral impact on escalated fillers).
// CIRCUIT_BREAKER_V2_SATURATED_ADDRESSES fires when an address's window no longer reaches
// back to this horizon, so volume growth surfaces on the dashboard rather than as a stuck
// recovery.
export const STREAK_FINALITY_LAG_SECS = 2 * 60 * 60;
// Cap on the block backoff: both the stored consecutiveBlocks counter and the duration
// exponent stop growing here, so a single block/extension increment is at most
// BASE_BLOCK_SECS * 2^7 = 32 hours (extensions stack: worst continuous bench in the 2-week
// backtest under the cap was ~64h, vs a 128h single block uncapped), and full recovery is
// bounded at MAX_BLOCK_BACKOFF_EXPONENT * CLEAN_RUNS_PER_DECAY clean runs rather than
// growing with block history. Costs ~20% of worst-offender fade containment in exchange for
// a bounded worst-case sentence and automatic recovery from pathological stored state.
export const MAX_BLOCK_BACKOFF_EXPONENT = 7;
// Minimum sample size before the chronic-rate watchlist metric is emitted, so one or two
// orders don't chart as a 0%/100% swing.
export const CHRONIC_RATE_MIN_SAMPLE = 10;
// Rate floor for emitting the chronic-rate watchlist metric. Without it, every filler at
// >= CHRONIC_RATE_MIN_SAMPLE orders/day gets a permanent per-filler CloudWatch series that
// sits flat near 0 and is never consulted; a series should start exactly when a filler
// becomes watch-worthy. Half the block threshold leaves generous headroom below the
// enforcement line while still charting anyone trending toward it.
export const CHRONIC_RATE_EMISSION_FLOOR = FADE_RATE_BLOCK_THRESHOLD / 2;

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

    const now = Math.floor(Date.now() / 1000);

    // compute each filler's Laplace-smoothed fade rates (post-block window + during-block cohort):
    //  | hash     |  fadeRate  |  duringBlockRate  |
    //  |---- foo -|---- 0.18 --|------ 0.05 -------|
    //  |---- bar -|---- 0.05 --|------ 0.20 -------|
    const fillerFadeStats = getFillersFadeStats(result, addressToFillerMap, fillerTimestamps, now, log);

    //  | hash        |lastExaminedTimestamp|blockUntilTimestamp|fadeWindowStart|
    //  |---- foo ----|---- 1300000 ----|----      calculated block until  ----|
    //  |---- bar ----|---- 1300000 ----|----      13500000                ----|
    const updatedTimestamps = calculateNewTimestamps(fillerTimestamps, fillerFadeStats, now, log, metrics);
    log.info({ updatedTimestamps }, 'filler for which to update timestamp');
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
  // Cap the stored counter, not just the duration exponent: full recovery costs
  // consecutiveBlocks * CLEAN_RUNS_PER_DECAY clean runs, so an uncapped counter would leave a
  // long-reformed filler one sub-threshold fade away from a max-length block indefinitely.
  return Math.min(consecutiveBlocks + 1, MAX_BLOCK_BACKOFF_EXPONENT);
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
    - Otherwise: reset blockUntilTimestamp to unblocked. consecutiveBlocks decays one level
      per CLEAN_RUNS_PER_DECAY consecutive clean runs (>=1 new completion, 0 new fades);
      a new fade resets the streak, idling freezes it — working off escalation requires
      sustained demonstrated clean activity. fadeWindowStart is left untouched so the
      clean-slate floor persists.

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
  let saturatedAddresses = 0;
  Object.entries(fillerFadeStats).forEach(([hash, stats]) => {
    const { fadeRate, duringBlockRate, newCompletions, newFades } = stats;
    saturatedAddresses += stats.saturatedAddresses;
    const fillerTimestamp = fillerTimestamps.get(hash);
    const isCurrentlyBlocked = fillerTimestamp && fillerTimestamp.blockUntilTimestamp > newPostTimestamp;
    // previousBlocks is the single clamped read of stored escalation: legacy rows predate the
    // backoff cap (values > MAX would extend recovery beyond the documented bound and chart
    // impossible levels), and corrupted rows could be negative (decay would drive them lower
    // and 2^negative yields sub-base fractional blocks). Clamping once here covers every
    // branch below — extend, keep, re-block, and decay — so pathological stored state
    // normalizes on the next run regardless of which path the filler takes.
    const previousBlocks = Math.min(Math.max(fillerTimestamp?.consecutiveBlocks || 0, 0), MAX_BLOCK_BACKOFF_EXPONENT);
    const previousCleanRuns = fillerTimestamp?.consecutiveCleanRuns || 0;

    // Per-filler rate so the distribution can be charted against FADE_RATE_BLOCK_THRESHOLD. While
    // blocked, fadeRate sits at the prior (post-block window is empty), so also emit the
    // during-block rate — the signal that actually drives extend/re-block — to chart benched
    // fillers against the same threshold.
    metrics?.putMetric(metricContext(Metric.CIRCUIT_BREAKER_V2_FADE_RATE, hash), fadeRate, Unit.None);
    if (isCurrentlyBlocked) {
      metrics?.putMetric(metricContext(Metric.CIRCUIT_BREAKER_V2_DURING_BLOCK_RATE, hash), duringBlockRate, Unit.None);
    }
    // Watchlist, not a trigger: the raw no-amnesty rate over the query window's final rows.
    // Backtests show a low-volume filler can sustain ~20% raw inside the block threshold's
    // envelope and that no trigger calibration catches them without unacceptable collateral —
    // this metric keeps them visible for human follow-up instead. Gated on sample size (so one
    // or two orders don't chart as a 0%/100% swing) and a rate floor (so a per-filler series
    // starts only when a filler becomes watch-worthy, not for every healthy filler forever).
    if (stats.chronicTotal >= CHRONIC_RATE_MIN_SAMPLE && stats.chronicRate >= CHRONIC_RATE_EMISSION_FLOOR) {
      metrics?.putMetric(metricContext(Metric.CIRCUIT_BREAKER_V2_CHRONIC_RATE, hash), stats.chronicRate, Unit.None);
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
        previousBlocks
      );
      consecutiveBlocks = newConsecutiveBlocks(previousBlocks);

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
        consecutiveCleanRuns: 0, // faded while blocked: recovery streak restarts
      });
    } else if (isCurrentlyBlocked) {
      // Blocked with the in-flight cohort under threshold - keep existing block and floor,
      // don't decay. Serving a bench is not recovery, so clean in-flight fills don't build
      // the decay streak either — but a sub-threshold in-flight fade still resets it.
      consecutiveBlocks = previousBlocks;
      updatedTimestamps.push({
        hash,
        lastExaminedTimestamp: newPostTimestamp,
        blockUntilTimestamp: fillerTimestamp.blockUntilTimestamp,
        fadeWindowStart: fillerTimestamp.fadeWindowStart,
        consecutiveBlocks,
        consecutiveCleanRuns: newFades > 0 ? 0 : previousCleanRuns,
      });
    } else if (fadeRate > FADE_RATE_BLOCK_THRESHOLD || duringBlockRate > FADE_RATE_BLOCK_THRESHOLD) {
      // duringBlockRate covers in-flight fades that landed near the end of a block that
      // expired between cron runs: they sit below the clean-slate floor, so this is the only
      // path that scores them. Over the rolling 24h window a filler can also cross the
      // threshold on a run with no new completions ("blocked while idle") as clean orders age
      // out; that is accepted behavior.
      const blockUntilTimestamp = calculateBlockUntilTimestamp(newPostTimestamp, previousBlocks);
      consecutiveBlocks = newConsecutiveBlocks(previousBlocks);

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
        consecutiveCleanRuns: 0, // blocked: recovery streak restarts
      });
    } else {
      // Under threshold: not blocked. Reset blockUntilTimestamp to unblocked. Escalation
      // decays one level only after CLEAN_RUNS_PER_DECAY consecutive clean runs (>=1 new
      // completion, 0 new fades): a new fade resets the streak — a sub-threshold fade is
      // not recovery — and an idle run freezes it (idling must not work off escalation).
      // fadeWindowStart is left as-is: it holds the last block end as the clean-slate
      // floor, so a returning filler is scored only on orders completed after their block
      // ended.
      let consecutiveCleanRuns: number;
      consecutiveBlocks = previousBlocks;
      if (previousBlocks === 0) {
        consecutiveCleanRuns = 0; // nothing to work off; don't accumulate a stale streak
      } else if (newFades > 0) {
        consecutiveCleanRuns = 0;
      } else if (newCompletions > 0) {
        consecutiveCleanRuns = previousCleanRuns + 1;
        if (consecutiveCleanRuns >= CLEAN_RUNS_PER_DECAY) {
          consecutiveBlocks = previousBlocks - 1;
          consecutiveCleanRuns = 0; // streak restarts for the next level
        }
      } else {
        consecutiveCleanRuns = previousCleanRuns; // idle: frozen
      }
      updatedTimestamps.push({
        hash,
        lastExaminedTimestamp: newPostTimestamp,
        blockUntilTimestamp: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
        fadeWindowStart: fillerTimestamp?.fadeWindowStart ?? UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
        consecutiveBlocks,
        consecutiveCleanRuns,
      });
    }

    // Emit the escalation level whenever the filler is or was escalated, so the chart steps
    // down through decay and plots the 0 when a filler fully recovers. Skip never-blocked
    // fillers (0 -> 0) to avoid a flat-zero series per filler.
    if (consecutiveBlocks > 0 || previousBlocks > 0) {
      metrics?.putMetric(
        metricContext(Metric.CIRCUIT_BREAKER_V2_CONSECUTIVE_BLOCKS, hash),
        consecutiveBlocks,
        Unit.Count
      );
    }
  });
  metrics?.putMetric(Metric.CIRCUIT_BREAKER_V2_NEW_BLOCKS, newBlocks, Unit.Count);
  metrics?.putMetric(Metric.CIRCUIT_BREAKER_V2_EXTENDED_BLOCKS, extendedBlocks, Unit.Count);
  metrics?.putMetric(Metric.CIRCUIT_BREAKER_V2_SATURATED_ADDRESSES, saturatedAddresses, Unit.Count);
  log?.info({ updatedTimestamps, newBlocks, extendedBlocks, saturatedAddresses }, 'updated timestamps');
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

   - newCompletions / newFades (streak inputs): rows classified as new against a horizon that
     trails wall clock by STREAK_FINALITY_LAG_SECS. Each run classifies deadlines in
     (lastExaminedTimestamp - LAG, now - LAG] — lastExaminedTimestamp advances to `now` every
     run, so consecutive runs' slices partition time and each row is classified exactly once,
     after its load state is final. newCompletions additionally requires deadline past the
     clean-slate floor (fills served while benched are not recovery); newFades counts any
     cohort (a during-bench fade still resets the streak).

   NOTE: cohort membership uses `deadline` (order completion time) instead of `postTimestamp`.
   This ensures orders posted before the last cron run but completed after are still counted,
   preventing the "in-flight orders" exploit.
*/
export function getFillersFadeStats(
  rows: V2FadesRowType[],
  addressToFillerMap: Map<string, string>,
  fillerTimestamps: FillerTimestamps,
  now: number,
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
    {
      windowFades: number;
      windowTotal: number;
      blockFades: number;
      blockTotal: number;
      newCompletions: number;
      newFades: number;
      chronicFades: number;
      chronicTotal: number;
    }
  > = {};
  // per-address row count and oldest deadline, to detect addresses whose latest-N window has
  // outrun the streak finality horizon (rows evicted before they can be classified)
  const addressRowCounts = new Map<string, number>();
  const addressOldestDeadline = new Map<string, number>();
  const addressHash = new Map<string, string>();
  rows.forEach((row) => {
    const fillerAddr = ethers.utils.getAddress(row.fillerAddress);
    const fillerHash = addressToFillerMap.get(fillerAddr);
    if (!fillerHash) {
      log?.info({ fillerAddr }, 'filler address not found dynamo mapping');
      return;
    }
    addressRowCounts.set(fillerAddr, (addressRowCounts.get(fillerAddr) ?? 0) + 1);
    addressOldestDeadline.set(fillerAddr, Math.min(addressOldestDeadline.get(fillerAddr) ?? Infinity, row.deadline));
    addressHash.set(fillerAddr, fillerHash);
    const fillerTimestamp = fillerTimestamps.get(fillerHash);
    if (!tallies[fillerHash]) {
      tallies[fillerHash] = {
        windowFades: 0,
        windowTotal: 0,
        blockFades: 0,
        blockTotal: 0,
        newCompletions: 0,
        newFades: 0,
        chronicFades: 0,
        chronicTotal: 0,
      };
    }
    const windowStart = fillerTimestamp?.fadeWindowStart ?? UNBLOCKED_BLOCK_UNTIL_TIMESTAMP;
    const lastExaminedTimestamp = fillerTimestamp?.lastExaminedTimestamp ?? 0;
    // Chronic (no-amnesty) view: every FINAL row in the query window, regardless of cohort.
    // Fresher rows are excluded for the same reason the streak defers them: a not-yet-loaded
    // fill reads as a transient fade and would sawtooth the watchlist metric every load cycle.
    if (row.deadline <= now - STREAK_FINALITY_LAG_SECS) {
      tallies[fillerHash].chronicTotal += 1;
      tallies[fillerHash].chronicFades += row.faded;
    }
    // Streak inputs, classified against the finality-lagged horizon so hourly-batch load lag
    // can't miss a late fade or count a not-yet-loaded fill as a transient fade. The slices
    // partition time across runs because lastExaminedTimestamp advances to `now` each run.
    if (
      row.deadline > lastExaminedTimestamp - STREAK_FINALITY_LAG_SECS &&
      row.deadline <= now - STREAK_FINALITY_LAG_SECS
    ) {
      if (row.deadline > windowStart) {
        // Bench fills (deadline on/before the floor) earn nothing toward recovery.
        tallies[fillerHash].newCompletions += 1;
      }
      tallies[fillerHash].newFades += row.faded;
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

  // An address is streak-degraded when it fills the latest-N cap AND its oldest returned row
  // is fresher than the finality horizon: rows are then evicted from the window before they
  // can ever be streak-classified. (Being at the cap alone is the designed adaptive window —
  // high-volume addresses sit there constantly — so it is deliberately not flagged.)
  const saturatedByHash: Record<string, number> = {};
  addressRowCounts.forEach((count, addr) => {
    const oldestDeadline = addressOldestDeadline.get(addr) ?? 0;
    if (count >= ORDERS_PER_FILLER_LIMIT && oldestDeadline > now - STREAK_FINALITY_LAG_SECS) {
      const hash = addressHash.get(addr)!;
      saturatedByHash[hash] = (saturatedByHash[hash] ?? 0) + 1;
      log?.info({ addr, hash, count, oldestDeadline }, 'filler address window has outrun the streak finality horizon');
    }
  });

  const stats: FillerFadeStatsMap = {};
  Object.entries(tallies).forEach(([hash, t]) => {
    stats[hash] = {
      fadeRate: laplaceSmoothedFadeRate(t.windowFades, t.windowTotal),
      duringBlockRate: laplaceSmoothedFadeRate(t.blockFades, t.blockTotal),
      newCompletions: t.newCompletions,
      newFades: t.newFades,
      chronicRate: t.chronicTotal > 0 ? t.chronicFades / t.chronicTotal : 0,
      chronicTotal: t.chronicTotal,
      saturatedAddresses: saturatedByHash[hash] ?? 0,
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
    - 7+ consecutive blocks: capped at 15 * 2^7 = 32 hours per increment
*/
export function calculateBlockUntilTimestamp(fromTimestamp: number, consecutiveBlocks: number | undefined): number {
  const blocks = Math.min(consecutiveBlocks || 0, MAX_BLOCK_BACKOFF_EXPONENT);
  return Math.floor(fromTimestamp + BASE_BLOCK_SECS * Math.pow(2, blocks));
}
