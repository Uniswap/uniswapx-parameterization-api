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
import { FadesScoringSource, FadesSourceKind, orderServiceScoringSource } from '../../lib/cron/fades-sources';
import { OrderServiceFadesSource, ResolutionSummary } from '../../lib/cron/order-service-fades-source';
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
    // A shadow source stand-in: canned rows (or an error / a hang), records the deadline it was given.
    class FakeShadowSource implements FadesScoringSource {
      public deadlineMs?: number;
      constructor(
        public readonly kind: FadesSourceKind,
        private readonly rows: V2FadesRowType[] | Error | 'hang',
        private readonly resolution?: ResolutionSummary
      ) {}
      fetchRows(): Promise<V2FadesRowType[]> {
        if (this.rows === 'hang') return new Promise<never>(() => undefined);
        if (this.rows instanceof Error) return Promise.reject(this.rows);
        return Promise.resolve(this.rows);
      }
      setDeadline(deadlineMs: number): void {
        this.deadlineMs = deadlineMs;
      }
      lastResolution(): ResolutionSummary | undefined {
        return this.resolution;
      }
    }
    const resolutionSummary = (): ResolutionSummary => ({
      pendingPastDeadline: 3,
      batches: 1,
      failedBatches: 0,
      skippedBatches: 0,
      resolved: 3,
      stillOpen: 0,
      notFound: 0,
      unclassifiable: 0,
      fillsWithoutVerdict: 0,
      failedWrites: 0,
      byOutcome: {},
    });

    // Scorer stand-in: one filler, blocked iff any fade in the rows it is given.
    const score = async (rows: V2FadesRowType[]) =>
      rows.length === 0
        ? []
        : [
            update(
              'fillerA',
              rows.some((r) => r.faded) ? { blockUntilTimestamp: NOW + 900, consecutiveBlocks: 1 } : {}
            ),
          ];

    const ctx = (overrides: Partial<ShadowContext> = {}): ShadowContext => ({
      primary: 'redshift',
      primaryRows: [row(ADDR_A, 1, NOW - 100, SINCE + 1), row(ADDR_A, 1, NOW - 50, SINCE - 1)],
      realUpdates: [update('fillerA', { blockUntilTimestamp: NOW + 900, consecutiveBlocks: 1 })],
      score,
      now: NOW,
      ...overrides,
    });

    it('emits the comparison metrics and a success marker, and returns the report', async () => {
      const { metrics, calls } = recordingMetrics();
      // The shadow (order service) has no rows: its scorer emits nothing, so production's block
      // is "only real"; restricted to the floor the primary side has one fade.
      const shadow = new FakeShadowSource('order-service', [], resolutionSummary());
      const report = await runFadeRateShadow(ctx(), { shadow, log, metrics, compareSince: SINCE });

      expect(report).toMatchObject({ primary: 'redshift', shadow: 'order-service' });
      expect(report?.rows).toMatchObject({ oldRows: 1, newRows: 0, oldFades: 1, newFades: 0, onlyNew: [] });
      expect(report?.rows.onlyOld).toEqual([`${ADDR_A.toLowerCase()}:${NOW - 100}`]);
      expect(report?.decisionsVsProduction).toMatchObject({ agree: 0, disagree: 0, onlyReal: ['fillerA'] });
      expect(report?.decisionsVsRestricted).toMatchObject({ agree: 0, disagree: 0, onlyReal: ['fillerA'] });
      expect(report?.wouldBlock).toBe(0);
      expect(report?.resolution).toMatchObject({ pendingPastDeadline: 3, resolved: 3 });

      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_SUCCESS]).toEqual([1]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_FAILURE]).toBeUndefined();
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_ROWS_OLD]).toEqual([1]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_ROWS_NEW]).toEqual([0]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_ROWS_ONLY_OLD]).toEqual([1]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_FADES_OLD]).toEqual([1]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_DECISION_AGREE]).toEqual([0]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_DECISION_DISAGREE]).toEqual([0]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_WOULD_BLOCK]).toEqual([0]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_PENDING_PAST_DEADLINE]).toEqual([3]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_DURATION]).toHaveLength(1);
    });

    it('keeps "old" = Redshift and "new" = order service when the roles are swapped', async () => {
      const { metrics, calls } = recordingMetrics();
      const primaryRows = [row(ADDR_A, 0, NOW - 100, SINCE + 1)]; // order-service primary: clean
      const redshiftShadow = new FakeShadowSource('redshift', [row(ADDR_A, 1, NOW - 100, SINCE + 1)]);
      const resolution = resolutionSummary();

      const report = await runFadeRateShadow(
        ctx({
          primary: 'order-service',
          primaryRows,
          primaryResolution: resolution,
          realUpdates: await score(primaryRows),
        }),
        { shadow: redshiftShadow, log, metrics, compareSince: SINCE }
      );

      expect(report).toMatchObject({ primary: 'order-service', shadow: 'redshift' });
      // Redshift saw a fade the order service did not: reported as an old-side fade.
      expect(report?.rows).toMatchObject({
        oldRows: 1,
        newRows: 1,
        oldFades: 1,
        newFades: 0,
        onlyOld: [],
        onlyNew: [],
      });
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_FADES_OLD]).toEqual([1]);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_FADES_NEW]).toEqual([0]);
      // Shadow (Redshift) would block, production (order service) did not.
      expect(report?.decisionsVsProduction).toMatchObject({ agree: 0, disagree: 1 });
      expect(report?.decisionsVsRestricted).toMatchObject({ agree: 0, disagree: 1 });
      expect(report?.wouldBlock).toBe(1);
      // The resolution summary is the primary's (order service) when it is primary.
      expect(report?.resolution).toBe(resolution);
    });

    it('scores the shadow rows with the injected production scorer and compares against both baselines', async () => {
      const { metrics } = recordingMetrics();
      const shadow = new FakeShadowSource('order-service', [row(ADDR_A, 1, NOW - 100, SINCE + 1)]);

      const report = await runFadeRateShadow(ctx(), { shadow, log, metrics, compareSince: SINCE });

      expect(report?.rows).toMatchObject({ oldRows: 1, newRows: 1, onlyOld: [], onlyNew: [] });
      expect(report?.decisionsVsProduction).toMatchObject({ agree: 1, disagree: 0 });
      expect(report?.decisionsVsRestricted).toMatchObject({ agree: 1, disagree: 0 });
      expect(report?.wouldBlock).toBe(1);
    });

    it('defaults the comparison floor to the PostedOrders go-live time and the budget to a minute', () => {
      expect(POSTED_ORDERS_LIVE_SINCE).toBe(Math.floor(Date.parse('2026-09-04T21:29:00Z') / 1000));
      expect(SHADOW_TIME_BUDGET_MS).toBe(60_000);
    });

    it('hands the shadow source a wallclock deadline derived from the budget', async () => {
      const { metrics } = recordingMetrics();
      const shadow = new FakeShadowSource('order-service', []);
      const before = Date.now();

      await runFadeRateShadow(ctx(), { shadow, log, metrics, budgetMs: 1234 });

      expect(shadow.deadlineMs).toBeGreaterThanOrEqual(before + 1234);
      expect(shadow.deadlineMs).toBeLessThanOrEqual(Date.now() + 1234);
    });

    it('propagates the deadline into a real OrderServiceFadesSource through its adapter', async () => {
      const { metrics } = recordingMetrics();
      const source = new OrderServiceFadesSource({
        postedOrders: new MockPostedOrderRepository(),
        orderStatus: new MockOrderStatusProvider(),
        fillerEndpoints: () => [],
        log,
        now: () => NOW,
      });
      const before = Date.now();

      await runFadeRateShadow(ctx(), { shadow: orderServiceScoringSource(source), log, metrics, budgetMs: 500 });

      expect(source.deadlineMs).toBeGreaterThanOrEqual(before + 500);
    });

    it('a throwing shadow source (e.g. Redshift not connectable) is logged and counted, never thrown', async () => {
      const { metrics, calls } = recordingMetrics();
      const shadow = new FakeShadowSource('redshift', new Error('Redshift endpoint is not connectable'));

      await expect(
        runFadeRateShadow(ctx({ primary: 'order-service' }), { shadow, log, metrics })
      ).resolves.toBeUndefined();

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

      await expect(
        runFadeRateShadow(context, { shadow: new FakeShadowSource('order-service', []), log, metrics })
      ).resolves.toBeUndefined();
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_FAILURE]).toEqual([1]);
    });

    it('a shadow source that hangs is cut off at the budget and counted as a failure', async () => {
      const { metrics, calls } = recordingMetrics();
      const shadow = new FakeShadowSource('redshift', 'hang');

      const started = Date.now();
      await expect(runFadeRateShadow(ctx(), { shadow, log, metrics, budgetMs: 30 })).resolves.toBeUndefined();

      expect(Date.now() - started).toBeLessThan(1000);
      expect(calls[Metric.CIRCUIT_BREAKER_SHADOW_FAILURE]).toEqual([1]);
    });
  });
});
