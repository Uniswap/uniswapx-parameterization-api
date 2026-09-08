import { createMetricsLogger, MetricsLogger, Unit } from 'aws-embedded-metrics';
import Logger from 'bunyan';

import {
  compareBlockDecisions,
  compareFadeRows,
  POSTED_ORDERS_LIVE_SINCE,
  runFadeRateShadow,
  SHADOW_TIME_BUDGET_MS,
  ShadowContext,
} from '../../lib/cron/fade-rate-shadow';
import { OrderServiceFadesSource } from '../../lib/cron/order-service-fades-source';
import { Metric } from '../../lib/entities';
import { MockOrderStatusProvider } from '../../lib/providers/order';
import { ToUpdateTimestampRow, V2FadesRowType } from '../../lib/repositories';
import { MockPostedOrderRepository } from '../../lib/repositories/posted-order-repository';
import { UNBLOCKED_BLOCK_UNTIL_TIMESTAMP } from '../../lib/repositories/timestamp-repository';

const log = Logger.createLogger({ name: 'test' });
log.level(Logger.FATAL);

const NOW = 1_800_000_000;
const SINCE = NOW - 10_000;
const ADDR_A = '0x00000000000000000000000000000000000000A1';
const ADDR_B = '0x00000000000000000000000000000000000000B1';

const row = (fillerAddress: string, faded: 0 | 1, deadline: number, postTimestamp = deadline - 60): V2FadesRowType => ({
  fillerAddress,
  faded,
  postTimestamp,
  deadline,
});

const update = (hash: string, overrides: Partial<ToUpdateTimestampRow> = {}): ToUpdateTimestampRow => ({
  hash,
  lastExaminedTimestamp: NOW,
  blockUntilTimestamp: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
  fadeWindowStart: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
  consecutiveBlocks: 0,
  consecutiveCleanRuns: 0,
  ...overrides,
});

// A real MetricsLogger (never flushed) with every putMetric recorded, so assertions run
// against the same object the cron hands the shadow.
function recordingMetrics(): { metrics: MetricsLogger; calls: Record<string, number[]> } {
  const metrics = createMetricsLogger();
  const calls: Record<string, number[]> = {};
  const original = metrics.putMetric.bind(metrics);
  metrics.putMetric = (key: string, value: number, unit?: Unit | string) => {
    (calls[key] ??= []).push(value);
    return original(key, value, unit);
  };
  return { metrics, calls };
}

describe('fade-rate shadow', () => {
  describe('compareFadeRows', () => {
    it('restricts both sides to orders posted at/after the floor', () => {
      const oldRows = [row(ADDR_A, 1, NOW - 100, SINCE - 1), row(ADDR_A, 0, NOW - 90, SINCE)];
      const newRows = [row(ADDR_A, 0, NOW - 90, SINCE + 5), row(ADDR_A, 1, NOW - 80, SINCE - 100)];

      const comparison = compareFadeRows(oldRows, newRows, SINCE);

      expect(comparison).toMatchObject({
        since: SINCE,
        oldRows: 1,
        newRows: 1,
        oldFades: 0,
        newFades: 0,
        onlyOld: [],
        onlyNew: [],
      });
    });

    it('matches rows on (fillerAddress, deadline) as a multiset, ignoring postTimestamp and address case', () => {
      const oldRows = [
        row(ADDR_A, 1, NOW - 100, NOW - 170),
        row(ADDR_A, 1, NOW - 100, NOW - 170), // duplicate key on the old side
        row(ADDR_A, 0, NOW - 50),
        row(ADDR_B, 1, NOW - 40),
      ];
      const newRows = [
        row(ADDR_A.toLowerCase(), 1, NOW - 100, NOW - 168), // postTimestamp drift is not a mismatch
        row(ADDR_A, 0, NOW - 50),
        row(ADDR_B, 0, NOW - 30),
      ];

      const comparison = compareFadeRows(oldRows, newRows, SINCE);

      expect(comparison.onlyOld).toEqual([
        `${ADDR_A.toLowerCase()}:${NOW - 100}`,
        `${ADDR_B.toLowerCase()}:${NOW - 40}`,
      ]);
      expect(comparison.onlyNew).toEqual([`${ADDR_B.toLowerCase()}:${NOW - 30}`]);
      expect(comparison).toMatchObject({ oldRows: 4, newRows: 3, oldFades: 3, newFades: 1 });
    });

    it('tallies totals and fades per filler address on both sides', () => {
      const comparison = compareFadeRows(
        [row(ADDR_A, 1, NOW - 100), row(ADDR_A, 0, NOW - 90), row(ADDR_B, 1, NOW - 80)],
        [row(ADDR_A, 1, NOW - 100), row(ADDR_A, 1, NOW - 90)],
        SINCE
      );

      expect(comparison.perFiller).toEqual({
        [ADDR_A.toLowerCase()]: { oldTotal: 2, oldFades: 1, newTotal: 2, newFades: 2 },
        [ADDR_B.toLowerCase()]: { oldTotal: 1, oldFades: 1, newTotal: 0, newFades: 0 },
      });
    });
  });

  describe('compareBlockDecisions', () => {
    it('agrees when blocked?, blockUntil and consecutiveBlocks all match', () => {
      const real = [
        update('a'),
        update('b', { blockUntilTimestamp: NOW + 900, fadeWindowStart: NOW + 900, consecutiveBlocks: 1 }),
      ];
      const shadow = [
        update('a', { consecutiveCleanRuns: 3 }),
        update('b', { blockUntilTimestamp: NOW + 900, consecutiveBlocks: 1 }),
      ];

      expect(compareBlockDecisions(real, shadow, NOW)).toEqual({
        agree: 2,
        disagree: 0,
        onlyReal: [],
        onlyShadow: [],
        disagreements: [],
      });
    });

    it('reports each disagreement with both decisions, and fillers present on one side only', () => {
      const real = [update('a'), update('b', { consecutiveBlocks: 2 }), update('onlyReal')];
      const shadow = [
        update('a', { blockUntilTimestamp: NOW + 900, consecutiveBlocks: 1 }),
        update('b', { consecutiveBlocks: 1 }),
        update('onlyShadow'),
      ];

      const comparison = compareBlockDecisions(real, shadow, NOW);

      expect(comparison).toMatchObject({ agree: 0, disagree: 2, onlyReal: ['onlyReal'], onlyShadow: ['onlyShadow'] });
      expect(comparison.disagreements).toEqual([
        {
          hash: 'a',
          real: { blocked: false, blockUntilTimestamp: 0, consecutiveBlocks: 0 },
          shadow: { blocked: true, blockUntilTimestamp: NOW + 900, consecutiveBlocks: 1 },
        },
        {
          hash: 'b',
          real: { blocked: false, blockUntilTimestamp: 0, consecutiveBlocks: 2 },
          shadow: { blocked: false, blockUntilTimestamp: 0, consecutiveBlocks: 1 },
        },
      ]);
    });

    it('treats a missing blockUntilTimestamp as unblocked', () => {
      const real = [{ ...update('a'), blockUntilTimestamp: undefined }];
      expect(compareBlockDecisions(real, [update('a')], NOW).agree).toBe(1);
    });
  });

  describe('runFadeRateShadow', () => {
    const emptySource = () =>
      new OrderServiceFadesSource({
        postedOrders: new MockPostedOrderRepository(),
        orderStatus: new MockOrderStatusProvider(),
        fillerEndpoints: () => [],
        log,
        now: () => NOW,
      });

    const ctx = (overrides: Partial<ShadowContext> = {}): ShadowContext => ({
      redshiftRows: [row(ADDR_A, 1, NOW - 100, SINCE + 1), row(ADDR_A, 1, NOW - 50, SINCE - 1)],
      realUpdates: [update('fillerA', { blockUntilTimestamp: NOW + 900, consecutiveBlocks: 1 })],
      // Scorer stand-in: one filler, blocked iff any fade in the rows it is given.
      score: async (rows) =>
        rows.length === 0
          ? []
          : [
              update(
                'fillerA',
                rows.some((r) => r.faded) ? { blockUntilTimestamp: NOW + 900, consecutiveBlocks: 1 } : {}
              ),
            ],
      now: NOW,
      ...overrides,
    });

    it('emits the comparison metrics and a success marker, and returns the report', async () => {
      const { metrics, calls } = recordingMetrics();
      // The new side has no rows (nothing in PostedOrders): the shadow scorer emits nothing, so
      // production's block is "only real"; restricted to the floor the old side has one fade.
      const report = await runFadeRateShadow(ctx(), { source: emptySource(), log, metrics, compareSince: SINCE });

      expect(report).toBeDefined();
      expect(report?.rows).toMatchObject({ oldRows: 1, newRows: 0, oldFades: 1, newFades: 0, onlyNew: [] });
      expect(report?.rows.onlyOld).toEqual([`${ADDR_A.toLowerCase()}:${NOW - 100}`]);
      expect(report?.decisionsVsProduction).toMatchObject({ agree: 0, disagree: 0, onlyReal: ['fillerA'] });
      expect(report?.decisionsVsRestricted).toMatchObject({ agree: 0, disagree: 0, onlyReal: ['fillerA'] });
      expect(report?.wouldBlock).toBe(0);
      expect(report?.resolution).toMatchObject({ pendingPastDeadline: 0, resolved: 0 });

      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_SUCCESS]).toEqual([1]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_FAILURE]).toBeUndefined();
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_ROWS_OLD]).toEqual([1]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_ROWS_NEW]).toEqual([0]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_ROWS_ONLY_OLD]).toEqual([1]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_FADES_OLD]).toEqual([1]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_DECISION_AGREE]).toEqual([0]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_DECISION_DISAGREE]).toEqual([0]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_WOULD_BLOCK]).toEqual([0]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_PENDING_PAST_DEADLINE]).toEqual([0]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_DURATION]).toHaveLength(1);
    });

    it('scores the new rows with the injected production scorer and compares against both baselines', async () => {
      const { metrics } = recordingMetrics();
      const source = emptySource();
      source.getFades = async () => [row(ADDR_A, 1, NOW - 100, SINCE + 1)];

      const report = await runFadeRateShadow(ctx(), { source, log, metrics, compareSince: SINCE });

      expect(report?.rows).toMatchObject({ oldRows: 1, newRows: 1, onlyOld: [], onlyNew: [] });
      expect(report?.decisionsVsProduction).toMatchObject({ agree: 1, disagree: 0 });
      expect(report?.decisionsVsRestricted).toMatchObject({ agree: 1, disagree: 0 });
      expect(report?.wouldBlock).toBe(1);
    });

    it('defaults the comparison floor to the PostedOrders go-live time and the budget to a minute', () => {
      expect(POSTED_ORDERS_LIVE_SINCE).toBe(Math.floor(Date.parse('2026-09-04T21:29:00Z') / 1000));
      expect(SHADOW_TIME_BUDGET_MS).toBe(60_000);
    });

    it('hands the source a wallclock deadline derived from the budget', async () => {
      const { metrics } = recordingMetrics();
      const source = emptySource();
      const before = Date.now();

      await runFadeRateShadow(ctx(), { source, log, metrics, budgetMs: 1234 });

      expect(source.deadlineMs).toBeGreaterThanOrEqual(before + 1234);
      expect(source.deadlineMs).toBeLessThanOrEqual(Date.now() + 1234);
    });

    it('a throwing source is logged and counted as a failure, never thrown', async () => {
      const { metrics, calls } = recordingMetrics();
      const source = emptySource();
      source.getFades = async () => {
        throw new Error('DynamoDB unavailable');
      };

      await expect(runFadeRateShadow(ctx(), { source, log, metrics })).resolves.toBeUndefined();

      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_FAILURE]).toEqual([1]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_SUCCESS]).toBeUndefined();
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_DURATION]).toHaveLength(1);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_ROWS_NEW]).toBeUndefined();
    });

    it('a throwing scorer (classification/comparison bug) is contained the same way', async () => {
      const { metrics, calls } = recordingMetrics();
      const context = ctx({
        score: async () => {
          throw new TypeError('bug');
        },
      });

      await expect(runFadeRateShadow(context, { source: emptySource(), log, metrics })).resolves.toBeUndefined();
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_FAILURE]).toEqual([1]);
    });

    it('a source that hangs is cut off at the budget and counted as a failure', async () => {
      const { metrics, calls } = recordingMetrics();
      const source = emptySource();
      source.getFades = () => new Promise<never>(() => undefined);

      const started = Date.now();
      await expect(runFadeRateShadow(ctx(), { source, log, metrics, budgetMs: 30 })).resolves.toBeUndefined();

      expect(Date.now() - started).toBeLessThan(1000);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_FAILURE]).toEqual([1]);
    });
  });
});
