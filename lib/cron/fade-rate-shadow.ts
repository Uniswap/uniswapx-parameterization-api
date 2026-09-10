import { MetricsLogger, Unit } from 'aws-embedded-metrics';
import Logger from 'bunyan';

import { Metric } from '../entities/aws-metrics-logger';
import { ToUpdateTimestampRow, V2FadesRowType } from '../repositories';
import { UNBLOCKED_BLOCK_UNTIL_TIMESTAMP } from '../repositories/timestamp-repository';
import { withTimeout } from '../util/time';
import { FadesScoringSource, FadesSourceKind } from './fades-sources';
import { ResolutionSummary } from './order-service-fades-source';

// Wall-time ceiling on everything the shadow adds to a cron run. The fade cron's Lambda timeout
// is 240s and the primary path runs first; one minute keeps the shadow comfortably inside that
// even if the primary is slow. An order-service shadow stops starting batches at this deadline;
// a Redshift shadow is simply cut off by the race below (its statement finishes server-side
// regardless, harmlessly).
export const SHADOW_TIME_BUDGET_MS = 60_000;

// First moment PostedOrders had every post (PR #495 deployed 2026-09-04 21:29Z). Redshift's
// 24h window contains orders older than this that the order-service source can never have, so
// the comparison is restricted to orders posted at/after this floor. Moot once the window has
// rolled past it; kept so the report's definition does not silently change.
export const POSTED_ORDERS_LIVE_SINCE = 1_788_557_340;

/**
 * What the cron hands the shadow after the primary path has written. `score` is the production
 * scoring code (getFillersFadeStats + calculateNewTimestamps) closed over the stored breaker
 * state the primary run used, with metrics disabled. It resolves the filler behind every address
 * the rows it is given name (the primary run's map, extended for addresses only these rows
 * mention) — so shadow decisions differ from the real ones only through the rows.
 */
export type ShadowContext = {
  primary: FadesSourceKind;
  primaryRows: V2FadesRowType[];
  // Outcome-resolution summary when the primary is the order service (the shadow's own summary
  // is read from the shadow source otherwise).
  primaryResolution?: ResolutionSummary;
  realUpdates: ToUpdateTimestampRow[];
  score: (rows: V2FadesRowType[]) => Promise<ToUpdateTimestampRow[]>;
  now: number;
};

export type ShadowDeps = {
  shadow: FadesScoringSource;
  log: Logger;
  metrics: MetricsLogger;
  compareSince?: number;
  budgetMs?: number;
};

export type PerFillerCounts = { oldTotal: number; oldFades: number; newTotal: number; newFades: number };

/**
 * Row-level comparison. "old" is always the Redshift side and "new" always the order-service
 * side, whichever of them is primary this run, so the ROWS_/FADES_ metrics keep one meaning
 * across the flip.
 */
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
  primary: FadesSourceKind;
  shadow: FadesSourceKind;
  durationMs: number;
  // The order-service side's outcome resolution this run, whichever role it played.
  resolution?: ResolutionSummary;
  rows: RowComparison;
  // Shadow decisions vs. what the primary actually wrote this run.
  decisionsVsProduction: DecisionComparison;
  // Both sides' rows restricted to the comparison floor and re-scored, then compared.
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
 * Runs the non-primary fades source next to the primary and reports how the two compare.
 * Writes nothing to FillerCBTimestampsV2 (it has no handle to it), notifies nobody, and never
 * throws: any failure — order-service timeout, Redshift connectivity, DynamoDB error, a bug in
 * classification or comparison, the time budget — is logged and counted as
 * CIRCUIT_BREAKER_SHADOW_FAILURE. Resolves to the report on success, undefined on failure.
 */
export async function runFadeRateShadow(ctx: ShadowContext, deps: ShadowDeps): Promise<ShadowReport | undefined> {
  const { shadow, log, metrics } = deps;
  const budgetMs = deps.budgetMs ?? SHADOW_TIME_BUDGET_MS;
  const since = deps.compareSince ?? POSTED_ORDERS_LIVE_SINCE;
  const start = Date.now();
  shadow.setDeadline?.(start + budgetMs);

  try {
    const report = await withTimeout(evaluate(ctx, shadow, since, start), budgetMs, 'fade shadow');
    emit(metrics, report);
    metrics.putMetric(Metric.CIRCUIT_BREAKER_SHADOW_SUCCESS, 1, Unit.Count);
    log.info(
      {
        primary: report.primary,
        shadow: report.shadow,
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
      {
        shadow: shadow.kind,
        error: e instanceof Error ? e.message : e,
        stack: e instanceof Error ? e.stack : undefined,
      },
      'fade circuit breaker shadow failed; primary decisions unaffected'
    );
    return undefined;
  }
}

async function evaluate(
  ctx: ShadowContext,
  shadow: FadesScoringSource,
  since: number,
  start: number
): Promise<ShadowReport> {
  const shadowRows = await shadow.fetchRows();
  const redshiftRows = shadow.kind === 'redshift' ? shadowRows : ctx.primaryRows;
  const orderServiceRows = shadow.kind === 'order-service' ? shadowRows : ctx.primaryRows;
  const sinceFloor = (rows: V2FadesRowType[]) => rows.filter((row) => row.postTimestamp >= since);

  const [shadowUpdates, restrictedPrimaryUpdates, restrictedShadowUpdates] = await Promise.all([
    ctx.score(shadowRows),
    ctx.score(sinceFloor(ctx.primaryRows)),
    ctx.score(sinceFloor(shadowRows)),
  ]);
  return {
    primary: ctx.primary,
    shadow: shadow.kind,
    durationMs: Date.now() - start,
    resolution: ctx.primary === 'order-service' ? ctx.primaryResolution : shadow.lastResolution?.(),
    rows: compareFadeRows(redshiftRows, orderServiceRows, since),
    decisionsVsProduction: compareBlockDecisions(ctx.realUpdates, shadowUpdates, ctx.now),
    decisionsVsRestricted: compareBlockDecisions(restrictedPrimaryUpdates, restrictedShadowUpdates, ctx.now),
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
