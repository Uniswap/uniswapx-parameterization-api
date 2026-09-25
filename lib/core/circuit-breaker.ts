import { ethers } from 'ethers';

import { FadesSource, ResolutionSummary } from '../cron/order-service-fades-source';
import { Metric, metricContext } from '../entities';
import { Context, Logger, Metrics } from '../observability';
import { S3WebhookConfigurationProvider } from '../providers';
import {
  BaseTimestampRepository,
  ORDERS_PER_FILLER_LIMIT,
  TimestampRepoRow,
  ToUpdateTimestampRow,
  V2FadesRowType,
} from '../repositories';
import { FillerAddressRepository } from '../repositories/filler-address-repository';
import { UNBLOCKED_BLOCK_UNTIL_TIMESTAMP } from '../repositories/timestamp-repository';

// Re-exported for the breaker's importers; the sentinel lives with the repository that owns the
// stored value's parse/write semantics.
export { UNBLOCKED_BLOCK_UNTIL_TIMESTAMP };

export type FillerFadeStats = {
  // Laplace-smoothed fade rate over the filler's post-block window (see getFillersFadeStats).
  // The source bounds the window to 24 hours OR the latest ORDERS_PER_FILLER_LIMIT orders per
  // address, whichever is smaller — so high-volume fillers are judged on recent orders (fast
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
  // Raw (unsmoothed) fade rate over the FINAL rows of the filler's window (24h / latest-100
  // per address, deadline past the finality horizon), ignoring the clean-slate floor — the
  // no-amnesty "chronic" view. Never used for blocking: emitted as a watchlist
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
// The streak classifies rows as "new" against a horizon that trails wall clock by this lag.
// It was introduced for the retired Redshift source, whose tables were batch-loaded hourly: a
// fade whose row loaded late never reset the streak, and a fill whose row had not loaded yet
// read as a transient fade. Neither can happen with the order-service source (an unresolved
// order contributes no row at all), so today the lag is a deliberate 2h delay on streak credit
// (newCompletions/newFades → consecutiveCleanRuns decay) and on chronicRate. Deliberately left
// unchanged when the Redshift path was removed: shrinking it changes recovery speed and is a
// tuning decision to make on its own, with a backtest (see CLAUDE.md).
//
// Known boundary (by design): a row is only classifiable while it survives in the source's
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

export interface CircuitBreakerDeps {
  // The breaker's input: per-order rows from PostedOrders + the order service. A failure here is
  // a failure of the run — there is no fallback source.
  source: FadesSource;
  webhookProvider: Pick<S3WebhookConfigurationProvider, 'fetchEndpoints' | 'fillerEndpoints'>;
  fillerAddressRepo: Pick<FillerAddressRepository, 'getAddressToFillerMap'>;
  timestampDB: BaseTimestampRepository;
  // Epoch seconds. Injected so tests pin the run's clock.
  now?: () => number;
}

export interface CircuitBreakerRunOptions {
  // Epoch ms by which the source's best-effort outcome resolution stops starting order-service
  // batches, so a slow order service truncates resolution (finished next run) rather than the
  // run. Set by a caller with a hard deadline (the Lambda); absent, resolution is unbounded.
  deadlineMs?: number;
}

/**
 * Resolves the filler (webhook) behind every address in the fade rows. Looks up exactly the
 * addresses the rows mention (one BatchGet per 100), then keeps only mappings to endpoints in
 * the current webhook config: an address whose filler has since been removed from the config
 * must not resurrect a timestamp row for it. Both kinds of gap — an address with no row and a
 * row pointing at an unconfigured endpoint — leave that address's fades benching nobody, so
 * each is logged with its count.
 */
export async function lookupFillersForRows(
  rows: V2FadesRowType[],
  fillerEndpoints: string[],
  fillerAddressRepo: Pick<FillerAddressRepository, 'getAddressToFillerMap'>,
  logger: Logger
): Promise<Map<string, string>> {
  const addresses = [...new Set(rows.map((row) => ethers.utils.getAddress(row.fillerAddress)))];
  if (addresses.length === 0) {
    return new Map();
  }
  const mapped = await fillerAddressRepo.getAddressToFillerMap(addresses);
  const configured = new Set(fillerEndpoints);
  const unconfigured = [...mapped.entries()].filter(([, filler]) => !configured.has(filler));
  const unattributed = addresses.filter((address) => !mapped.has(address));
  if (unconfigured.length > 0 || unattributed.length > 0) {
    logger.warn('fade rows whose address resolves to no configured filler; their fades bench nobody this run', {
      unattributedAddresses: unattributed.length,
      unconfiguredAddresses: unconfigured.length,
      unconfiguredEndpoints: [...new Set(unconfigured.map(([, filler]) => filler))],
    });
  }
  return new Map([...mapped.entries()].filter(([, filler]) => configured.has(filler)));
}

/**
 * One run of the fade circuit breaker, independent of what schedules it: refresh the webhook
 * config, read the recently completed orders, score each filler's fade rates, and write the
 * resulting block decisions to FillerCBTimestampsV2.
 *
 * It knows nothing about Lambda or EventBridge, so the backend monorepo port can reuse it
 * unchanged behind its own scheduler.
 */
export class CircuitBreakerBL {
  constructor(private readonly deps: CircuitBreakerDeps) {}

  public async run(ctx: Context, opts: CircuitBreakerRunOptions = {}): Promise<void> {
    const { source, webhookProvider, fillerAddressRepo, timestampDB } = this.deps;
    const { logger, metrics } = ctx;

    // The webhook config provider reports RFQ_CONFIG_CHANGED through the caller's ctx, so the
    // refresh emits into this run's metrics.
    await webhookProvider.fetchEndpoints(ctx);
    // Best-effort outcome resolution may not eat the whole invocation: what it does not resolve
    // now, it resolves next run.
    if (opts.deadlineMs !== undefined) {
      source.deadlineMs = opts.deadlineMs;
    }
    /*
     rows: one per recently completed order
          | fillerAddress |    faded  |   postTimestamp |   deadline   |
          |---- 0x1 ------|---- 0 ----|---- 12222222 ---|--- 12222282 -|
          |---- 0x2 ------|---- 1 ----|---- 12345679 ---|--- 12345739 -|
          |---- 0x1 ------|---- 0 ----|---- 12345678 ---|--- 12345738 -|
    */
    const rows = await source.getFades();

    const fillerEndpoints = webhookProvider.fillerEndpoints();
    const [addressToFillerMap, fillerTimestamps] = await Promise.all([
      lookupFillersForRows(rows, fillerEndpoints, fillerAddressRepo, logger),
      timestampDB.getFillerTimestampsMap(fillerEndpoints),
    ]);

    const now = this.deps.now ? this.deps.now() : Math.floor(Date.now() / 1000);

    // compute each filler's Laplace-smoothed fade rates (post-block window + during-block cohort):
    //  | hash     |  fadeRate  |  duringBlockRate  |
    //  |---- foo -|---- 0.18 --|------ 0.05 -------|
    //  |---- bar -|---- 0.05 --|------ 0.20 -------|
    const fillerFadeStats = getFillersFadeStats(rows, addressToFillerMap, fillerTimestamps, now, logger);

    //  | hash        |lastExaminedTimestamp|blockUntilTimestamp|fadeWindowStart|
    //  |---- foo ----|---- 1300000 ----|----      calculated block until  ----|
    //  |---- bar ----|---- 1300000 ----|----      13500000                ----|
    const updatedTimestamps = calculateNewTimestamps(fillerTimestamps, fillerFadeStats, now, logger, metrics);
    logger.info('filler for which to update timestamp', { updatedTimestamps });
    void metrics.count(
      Metric.CIRCUIT_BREAKER_V2_ACTIVE_BLOCKS,
      countActiveBlocks(fillerTimestamps, updatedTimestamps, now)
    );
    void metrics.count(Metric.CIRCUIT_BREAKER_V2_FILLERS_EVALUATED, Object.keys(fillerFadeStats).length);
    if (updatedTimestamps.length > 0) {
      await timestampDB.updateTimestampsBatch(updatedTimestamps);
    } else {
      logger.info('no timestamp to update');
    }

    if (source.lastResolution) {
      emitOrderResolutionMetrics(metrics, source.lastResolution);
    }
  }
}

export function emitOrderResolutionMetrics(metrics: Metrics, r: ResolutionSummary): void {
  const put = (metric: Metric, value: number) => void metrics.count(metric, value);
  put(Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_PENDING_PAST_DEADLINE, r.pendingPastDeadline);
  put(Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_PENDING_SATURATED, r.pendingSaturated ? 1 : 0);
  put(Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_RESOLVED, r.resolved);
  put(Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_STILL_OPEN, r.stillOpen);
  put(Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_NOT_FOUND, r.notFound);
  put(Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_UNCLASSIFIABLE, r.unclassifiable);
  put(Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_FILLS_WITHOUT_VERDICT, r.fillsWithoutVerdict);
  put(Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_GIVEN_UP, r.givenUp);
  put(Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_FAILED_WRITES, r.failedWrites);
  put(Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_FAILED_BATCHES, r.failedBatches);
  put(Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_SKIPPED_BATCHES, r.skippedBatches);
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
  logger?: Logger,
  metrics?: Metrics
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
    void metrics?.gauge(metricContext(Metric.CIRCUIT_BREAKER_V2_FADE_RATE, hash), fadeRate);
    if (isCurrentlyBlocked) {
      void metrics?.gauge(metricContext(Metric.CIRCUIT_BREAKER_V2_DURING_BLOCK_RATE, hash), duringBlockRate);
    }
    // Watchlist, not a trigger: the raw no-amnesty rate over the query window's final rows.
    // Backtests show a low-volume filler can sustain ~20% raw inside the block threshold's
    // envelope and that no trigger calibration catches them without unacceptable collateral —
    // this metric keeps them visible for human follow-up instead. Gated on sample size (so one
    // or two orders don't chart as a 0%/100% swing) and a rate floor (so a per-filler series
    // starts only when a filler becomes watch-worthy, not for every healthy filler forever).
    if (stats.chronicTotal >= CHRONIC_RATE_MIN_SAMPLE && stats.chronicRate >= CHRONIC_RATE_EMISSION_FLOOR) {
      void metrics?.gauge(metricContext(Metric.CIRCUIT_BREAKER_V2_CHRONIC_RATE, hash), stats.chronicRate);
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
      logger?.info('Extending block for filler who faded while blocked', {
        hash,
        currentBlockUntil: fillerTimestamp.blockUntilTimestamp,
        extendedBlockUntil,
        duringBlockRate,
      });

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
      logger?.info('Blocking filler for exceeding fade rate threshold', {
        hash,
        fadeRate,
        duringBlockRate,
        blockUntilTimestamp,
      });

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
      void metrics?.count(metricContext(Metric.CIRCUIT_BREAKER_V2_CONSECUTIVE_BLOCKS, hash), consecutiveBlocks);
    }
  });
  void metrics?.count(Metric.CIRCUIT_BREAKER_V2_NEW_BLOCKS, newBlocks);
  void metrics?.count(Metric.CIRCUIT_BREAKER_V2_EXTENDED_BLOCKS, extendedBlocks);
  void metrics?.count(Metric.CIRCUIT_BREAKER_V2_SATURATED_ADDRESSES, saturatedAddresses);
  logger?.info('updated timestamps', { updatedTimestamps, newBlocks, extendedBlocks, saturatedAddresses });
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
     that are still inside the source's rolling window. While a filler is currently blocked
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
  logger?: Logger
): FillerFadeStatsMap {
  // Counts only: the full row set is ~170 KB per run and never needed for diagnosis (the
  // per-filler tallies and stats below are).
  logger?.info('getFillersFadeStats', {
    rowCount: rows.length,
    fadeCount: rows.reduce((sum, row) => sum + row.faded, 0),
    fillerTimestamps: [...fillerTimestamps.entries()],
    addressToFillerMap: [...addressToFillerMap.entries()],
  });
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
      logger?.info('filler address not found dynamo mapping', { fillerAddr });
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
    // Chronic (no-amnesty) view: every FINAL row in the window, regardless of cohort. Fresher
    // rows are excluded for the same reason the streak defers them (see STREAK_FINALITY_LAG_SECS).
    if (row.deadline <= now - STREAK_FINALITY_LAG_SECS) {
      tallies[fillerHash].chronicTotal += 1;
      tallies[fillerHash].chronicFades += row.faded;
    }
    // Streak inputs, classified against the finality-lagged horizon (see STREAK_FINALITY_LAG_SECS).
    // The slices partition time across runs because lastExaminedTimestamp advances to `now` each run.
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
    const hash = addressHash.get(addr); // always set: written alongside addressRowCounts above
    if (hash !== undefined && count >= ORDERS_PER_FILLER_LIMIT && oldestDeadline > now - STREAK_FINALITY_LAG_SECS) {
      saturatedByHash[hash] = (saturatedByHash[hash] ?? 0) + 1;
      logger?.info('filler address window has outrun the streak finality horizon', {
        addr,
        hash,
        count,
        oldestDeadline,
      });
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
  logger?.info('fade stats by filler', { tallies, stats });
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
