import { MetricsLogger, Unit } from 'aws-embedded-metrics';
import Logger from 'bunyan';

import { Metric } from '../entities/aws-metrics-logger';
import { ToUpdateTimestampRow, V2FadesRowType } from '../repositories';
import { UNBLOCKED_BLOCK_UNTIL_TIMESTAMP } from '../repositories/timestamp-repository';
import { OrderServiceFadesSource, ResolutionSummary } from './order-service-fades-source';

// Wall-time ceiling on everything the shadow adds to a cron run (order-service batches,
// DynamoDB reads/writes, scoring). The fade cron's Lambda timeout is 240s and the Redshift
// path runs first; one minute keeps the shadow comfortably inside that even if the Redshift
// path is slow. The source stops starting order-service batches at this deadline, and the
// runner races the whole thing against it as a backstop.
export const SHADOW_TIME_BUDGET_MS = 60_000;

// First moment PostedOrders had every post (PR #495 deployed 2026-09-04 21:29Z). Redshift's
// 24h window contains orders older than this that the new source can never have, so the
// comparison is restricted to orders posted at/after this floor. After the first day of shadow
// the floor is moot (everything in the window is newer).
export const POSTED_ORDERS_LIVE_SINCE = 1_788_557_340;

/**
 * What the cron hands the shadow after the real path has written. `score` is the production
 * scoring code (getFillersFadeStats + calculateNewTimestamps) closed over the stored breaker
 * state and address map the real run used, with metrics disabled — so shadow decisions differ
 * from the real ones only through the rows.
 */
export type ShadowContext = {
  redshiftRows: V2FadesRowType[];
  realUpdates: ToUpdateTimestampRow[];
  score: (rows: V2FadesRowType[]) => ToUpdateTimestampRow[];
  now: number;
};

export type ShadowDeps = {
  source: OrderServiceFadesSource;
  log: Logger;
  metrics: MetricsLogger;
  compareSince?: number;
  budgetMs?: number;
};

export type PerFillerCounts = { oldTotal: number; oldFades: number; newTotal: number; newFades: number };

export type RowComparison = {
  since: number;
  oldRows: number;
  newRows: number;
  oldFades: number;
  newFades: number;
  // (fillerAddress, deadline) keys present on one side only, as a multiset difference.
  onlyOld: string[];
  onlyNew: string[];
  // Keyed by lowercased filler address.
  perFiller: Record<string, PerFillerCounts>;
};

export type Decision = { blocked: boolean; blockUntilTimestamp: number; consecutiveBlocks: number };

export type DecisionComparison = {
  agree: number;
  disagree: number;
  onlyReal: string[];
  onlyShadow: string[];
  disagreements: { hash: string; real: Decision; shadow: Decision }[];
};

export type ShadowReport = {
  durationMs: number;
  resolution?: ResolutionSummary;
  rows: RowComparison;
  // Shadow decisions vs. what the Redshift path actually wrote this run.
  decisionsVsProduction: DecisionComparison;
  // Shadow decisions vs. the Redshift rows re-scored with the same go-live floor.
  decisionsVsRestricted: DecisionComparison;
  wouldBlock: number;
};

const rowKey = (row: V2FadesRowType) => `${row.fillerAddress.toLowerCase()}:${row.deadline}`;

/**
 * Row-level parity, both sides restricted to orders posted at/after `since`. Rows are matched
 * on (fillerAddress, deadline): the SQL's postTimestamp is the order service's createdat while
 * ours is the post-confirmation time, so postTimestamp is not a join key.
 */
export function compareFadeRows(oldRows: V2FadesRowType[], newRows: V2FadesRowType[], since: number): RowComparison {
  const old = oldRows.filter((row) => row.postTimestamp >= since);
  const fresh = newRows.filter((row) => row.postTimestamp >= since);

  const counts = new Map<string, number>();
  old.forEach((row) => counts.set(rowKey(row), (counts.get(rowKey(row)) ?? 0) + 1));
  fresh.forEach((row) => counts.set(rowKey(row), (counts.get(rowKey(row)) ?? 0) - 1));
  const onlyOld: string[] = [];
  const onlyNew: string[] = [];
  counts.forEach((delta, key) => {
    for (let i = 0; i < delta; i++) onlyOld.push(key);
    for (let i = 0; i < -delta; i++) onlyNew.push(key);
  });

  const perFiller: Record<string, PerFillerCounts> = {};
  const tally = (row: V2FadesRowType, side: 'old' | 'new') => {
    const key = row.fillerAddress.toLowerCase();
    perFiller[key] ??= { oldTotal: 0, oldFades: 0, newTotal: 0, newFades: 0 };
    perFiller[key][`${side}Total`] += 1;
    perFiller[key][`${side}Fades`] += row.faded;
  };
  old.forEach((row) => tally(row, 'old'));
  fresh.forEach((row) => tally(row, 'new'));

  return {
    since,
    oldRows: old.length,
    newRows: fresh.length,
    oldFades: old.reduce((sum, row) => sum + row.faded, 0),
    newFades: fresh.reduce((sum, row) => sum + row.faded, 0),
    onlyOld: onlyOld.sort(),
    onlyNew: onlyNew.sort(),
    perFiller,
  };
}

const toDecision = (row: ToUpdateTimestampRow, now: number): Decision => {
  const blockUntilTimestamp = row.blockUntilTimestamp ?? UNBLOCKED_BLOCK_UNTIL_TIMESTAMP;
  return { blocked: blockUntilTimestamp > now, blockUntilTimestamp, consecutiveBlocks: row.consecutiveBlocks };
};

/** Per-filler block decisions: agree when blocked?, blockUntil and consecutiveBlocks all match. */
export function compareBlockDecisions(
  real: ToUpdateTimestampRow[],
  shadow: ToUpdateTimestampRow[],
  now: number
): DecisionComparison {
  const realByHash = new Map(real.map((row) => [row.hash, toDecision(row, now)]));
  const shadowByHash = new Map(shadow.map((row) => [row.hash, toDecision(row, now)]));
  const comparison: DecisionComparison = { agree: 0, disagree: 0, onlyReal: [], onlyShadow: [], disagreements: [] };

  realByHash.forEach((realDecision, hash) => {
    const shadowDecision = shadowByHash.get(hash);
    if (!shadowDecision) {
      comparison.onlyReal.push(hash);
      return;
    }
    const same =
      realDecision.blocked === shadowDecision.blocked &&
      realDecision.blockUntilTimestamp === shadowDecision.blockUntilTimestamp &&
      realDecision.consecutiveBlocks === shadowDecision.consecutiveBlocks;
    if (same) {
      comparison.agree += 1;
    } else {
      comparison.disagree += 1;
      comparison.disagreements.push({ hash, real: realDecision, shadow: shadowDecision });
    }
  });
  shadowByHash.forEach((_, hash) => {
    if (!realByHash.has(hash)) comparison.onlyShadow.push(hash);
  });
  comparison.onlyReal.sort();
  comparison.onlyShadow.sort();
  return comparison;
}

/**
 * Runs the order-service fades source next to the Redshift path and reports how the two
 * compare. Writes nothing to FillerCBTimestampsV2 (it has no handle to it), notifies nobody,
 * and never throws: any failure — order-service timeout, DynamoDB error, a bug in
 * classification or comparison, the time budget — is logged and counted as
 * CIRCUIT_BREAKER_SHADOW_FAILURE. Resolves to the report on success, undefined on failure.
 */
export async function runFadeRateShadow(ctx: ShadowContext, deps: ShadowDeps): Promise<ShadowReport | undefined> {
  const { source, log, metrics } = deps;
  const budgetMs = deps.budgetMs ?? SHADOW_TIME_BUDGET_MS;
  const since = deps.compareSince ?? POSTED_ORDERS_LIVE_SINCE;
  const start = Date.now();
  source.deadlineMs = start + budgetMs;

  try {
    const report = await withTimeout(evaluate(ctx, source, since, start), budgetMs);
    emit(metrics, report);
    metrics.putMetric(Metric.CIRCUIT_BREAKER_SHADOW_SUCCESS, 1, Unit.Count);
    log.info(
      {
        durationMs: report.durationMs,
        resolution: report.resolution,
        rows: { ...report.rows, perFiller: undefined },
        perFiller: report.rows.perFiller,
        decisionsVsProduction: report.decisionsVsProduction,
        decisionsVsRestricted: report.decisionsVsRestricted,
        wouldBlock: report.wouldBlock,
      },
      'fade circuit breaker shadow report'
    );
    return report;
  } catch (e) {
    metrics.putMetric(Metric.CIRCUIT_BREAKER_SHADOW_FAILURE, 1, Unit.Count);
    metrics.putMetric(Metric.CIRCUIT_BREAKER_SHADOW_DURATION, Date.now() - start, Unit.Milliseconds);
    log.error(
      { error: e instanceof Error ? e.message : e, stack: e instanceof Error ? e.stack : undefined },
      'fade circuit breaker shadow failed; real decisions unaffected'
    );
    return undefined;
  }
}

async function evaluate(
  ctx: ShadowContext,
  source: OrderServiceFadesSource,
  since: number,
  start: number
): Promise<ShadowReport> {
  const newRows = await source.getFades();
  const rows = compareFadeRows(ctx.redshiftRows, newRows, since);
  const shadowUpdates = ctx.score(newRows);
  const restrictedRealUpdates = ctx.score(ctx.redshiftRows.filter((row) => row.postTimestamp >= since));
  return {
    durationMs: Date.now() - start,
    resolution: source.lastResolution,
    rows,
    decisionsVsProduction: compareBlockDecisions(ctx.realUpdates, shadowUpdates, ctx.now),
    decisionsVsRestricted: compareBlockDecisions(restrictedRealUpdates, shadowUpdates, ctx.now),
    wouldBlock: shadowUpdates.filter((row) => (row.blockUntilTimestamp ?? UNBLOCKED_BLOCK_UNTIL_TIMESTAMP) > ctx.now)
      .length,
  };
}

function emit(metrics: MetricsLogger, report: ShadowReport): void {
  const put = (metric: Metric, value: number, unit: Unit = Unit.Count) => metrics.putMetric(metric, value, unit);
  put(Metric.CIRCUIT_BREAKER_SHADOW_DURATION, report.durationMs, Unit.Milliseconds);
  if (report.resolution) {
    put(Metric.CIRCUIT_BREAKER_SHADOW_PENDING_PAST_DEADLINE, report.resolution.pendingPastDeadline);
    put(Metric.CIRCUIT_BREAKER_SHADOW_RESOLVED, report.resolution.resolved);
    put(Metric.CIRCUIT_BREAKER_SHADOW_STILL_OPEN, report.resolution.stillOpen);
    put(Metric.CIRCUIT_BREAKER_SHADOW_NOT_FOUND, report.resolution.notFound);
    put(Metric.CIRCUIT_BREAKER_SHADOW_UNCLASSIFIABLE, report.resolution.unclassifiable);
  }
  put(Metric.CIRCUIT_BREAKER_SHADOW_ROWS_OLD, report.rows.oldRows);
  put(Metric.CIRCUIT_BREAKER_SHADOW_ROWS_NEW, report.rows.newRows);
  put(Metric.CIRCUIT_BREAKER_SHADOW_ROWS_ONLY_OLD, report.rows.onlyOld.length);
  put(Metric.CIRCUIT_BREAKER_SHADOW_ROWS_ONLY_NEW, report.rows.onlyNew.length);
  put(Metric.CIRCUIT_BREAKER_SHADOW_FADES_OLD, report.rows.oldFades);
  put(Metric.CIRCUIT_BREAKER_SHADOW_FADES_NEW, report.rows.newFades);
  put(Metric.CIRCUIT_BREAKER_SHADOW_DECISION_AGREE, report.decisionsVsProduction.agree);
  put(Metric.CIRCUIT_BREAKER_SHADOW_DECISION_DISAGREE, report.decisionsVsProduction.disagree);
  put(Metric.CIRCUIT_BREAKER_SHADOW_DECISION_AGREE_RESTRICTED, report.decisionsVsRestricted.agree);
  put(Metric.CIRCUIT_BREAKER_SHADOW_DECISION_DISAGREE_RESTRICTED, report.decisionsVsRestricted.disagree);
  put(Metric.CIRCUIT_BREAKER_SHADOW_WOULD_BLOCK, report.wouldBlock);
}

// Promise.race keeps subscribing to the loser, so a source that fails after the budget fired
// is swallowed rather than surfacing as an unhandled rejection; the timer is always cleared.
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`fade shadow exceeded its ${ms}ms budget`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
