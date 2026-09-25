import { createMetricsLogger, MetricsLogger, Unit } from 'aws-embedded-metrics';
import Logger from 'bunyan';

import { BASE_BLOCK_SECS } from '../../lib/core/circuit-breaker';
import { FadeRateCronDeps, LAMBDA_EXIT_MARGIN_MS, runFadeRateCron } from '../../lib/cron/fade-rate-v2';
import { FadesSource, ResolutionSummary } from '../../lib/cron/order-service-fades-source';
import { Metric, metricContext } from '../../lib/entities';
import { Context } from '../../lib/observability';
import {
  BaseTimestampRepository,
  TimestampRepoRow,
  ToUpdateTimestampRow,
  V2FadesRowType,
} from '../../lib/repositories';
import { MockFillerAddressRepository } from '../../lib/repositories/filler-address-repository';
import { UNBLOCKED_BLOCK_UNTIL_TIMESTAMP } from '../../lib/repositories/timestamp-repository';

const NOW = 1_800_000_000;
const FILLER_A = 'https://filler-a.example/rfq';
const FILLER_B = 'https://filler-b.example/rfq';
const ADDR_A = '0x00000000000000000000000000000000000000A1';
const ADDR_B = '0x00000000000000000000000000000000000000B1';

const row = (fillerAddress: string, faded: 0 | 1, deadline: number): V2FadesRowType => ({
  fillerAddress,
  faded,
  postTimestamp: deadline - 60,
  deadline,
});

// The breaker's input: canned rows or an error, plus what the cron reads back from it.
class FakeSource implements FadesSource {
  public calls = 0;
  public deadlineMs?: number;
  public lastResolution?: ResolutionSummary;
  constructor(private readonly rows: V2FadesRowType[] | Error, private readonly order?: string[]) {}
  async getFades(): Promise<V2FadesRowType[]> {
    this.calls += 1;
    this.order?.push('fetch');
    if (this.rows instanceof Error) throw this.rows;
    return this.rows;
  }
}

class FakeWebhookProvider {
  public fetched = 0;
  public ctx: Context | undefined;
  constructor(private readonly endpoints: string[]) {}
  // Stands in for a refresh that observed a config change.
  async fetchEndpoints(ctx: Context): Promise<void> {
    this.fetched += 1;
    this.ctx = ctx;
    await ctx.metrics.count(Metric.RFQ_CONFIG_CHANGED);
  }
  fillerEndpoints(): string[] {
    return this.endpoints;
  }
}

// FillerCBTimestampsV2 stand-in: stored state in, every batch write recorded verbatim.
class FakeTimestampRepository implements BaseTimestampRepository {
  public writes: ToUpdateTimestampRow[][] = [];
  constructor(
    private readonly stored: Map<string, Omit<TimestampRepoRow, 'hash'>> = new Map(),
    private readonly order?: string[]
  ) {}
  async updateTimestampsBatch(toUpdate: ToUpdateTimestampRow[]): Promise<void> {
    this.order?.push('write');
    this.writes.push(toUpdate.map((r) => ({ ...r })));
  }
  async getFillerTimestamps(hash: string): Promise<TimestampRepoRow> {
    const stored = this.stored.get(hash);
    return {
      hash,
      lastExaminedTimestamp: stored?.lastExaminedTimestamp ?? 0,
      blockUntilTimestamp: stored?.blockUntilTimestamp ?? UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
      fadeWindowStart: stored?.fadeWindowStart ?? UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
      consecutiveBlocks: stored?.consecutiveBlocks ?? 0,
      consecutiveCleanRuns: stored?.consecutiveCleanRuns ?? 0,
    };
  }
  async getTimestampsBatch(hashes: string[]): Promise<TimestampRepoRow[]> {
    return Promise.all(hashes.filter((h) => this.stored.has(h)).map((h) => this.getFillerTimestamps(h)));
  }
  async getFillerTimestampsMap(hashes: string[]): Promise<Map<string, Omit<TimestampRepoRow, 'hash'>>> {
    const rows = await this.getTimestampsBatch(hashes);
    return new Map(rows.map(({ hash, ...rest }) => [hash, rest]));
  }
}

function recordingMetrics(): {
  metrics: MetricsLogger;
  calls: Record<string, number[]>;
  units: Record<string, Set<Unit | string | undefined>>;
} {
  const metrics = createMetricsLogger();
  const calls: Record<string, number[]> = {};
  const units: Record<string, Set<Unit | string | undefined>> = {};
  const originalPut = metrics.putMetric.bind(metrics);
  metrics.putMetric = (key: string, value: number, unit?: Unit | string) => {
    (calls[key] ??= []).push(value);
    (units[key] ??= new Set()).add(unit);
    return originalPut(key, value, unit);
  };
  return { metrics, calls, units };
}

// A bunyan logger writing to an in-memory ring so tests can inspect record fields.
function recordingLog(): { log: Logger; records: Record<string, unknown>[] } {
  const ring = new Logger.RingBuffer({ limit: 500 });
  const log = Logger.createLogger({ name: 'test', streams: [{ type: 'raw', stream: ring, level: 'info' }] });
  return { log, records: ring.records as Record<string, unknown>[] };
}

// Filler A fades 5 of 5 (blocks); filler B fills 5 of 5 (stays clear).
const BLOCKING_ROWS: V2FadesRowType[] = [
  ...Array.from({ length: 5 }, (_, i) => row(ADDR_A, 1, NOW - 100 - i)),
  ...Array.from({ length: 5 }, (_, i) => row(ADDR_B, 0, NOW - 100 - i)),
];

const BLOCK_A_DECISIONS: ToUpdateTimestampRow[] = [
  {
    hash: FILLER_A,
    lastExaminedTimestamp: NOW,
    blockUntilTimestamp: NOW + BASE_BLOCK_SECS,
    fadeWindowStart: NOW + BASE_BLOCK_SECS,
    consecutiveBlocks: 1,
    consecutiveCleanRuns: 0,
  },
  {
    hash: FILLER_B,
    lastExaminedTimestamp: NOW,
    blockUntilTimestamp: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
    fadeWindowStart: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
    consecutiveBlocks: 0,
    consecutiveCleanRuns: 0,
  },
];

const RESOLUTION: ResolutionSummary = {
  pendingPastDeadline: 7,
  pendingSaturated: false,
  batches: 1,
  failedBatches: 0,
  skippedBatches: 0,
  resolved: 5,
  stillOpen: 1,
  notFound: 0,
  unclassifiable: 0,
  fillsWithoutVerdict: 1,
  givenUp: 0,
  failedWrites: 0,
  byOutcome: {},
};

async function fillerAddresses(): Promise<MockFillerAddressRepository> {
  const repo = new MockFillerAddressRepository();
  await repo.recordWinningAddress(ADDR_A, FILLER_A);
  await repo.recordWinningAddress(ADDR_B, FILLER_B);
  return repo;
}

type RunOptions = {
  rows: V2FadesRowType[] | Error;
  addresses?: MockFillerAddressRepository;
  endpoints?: string[];
  resolution?: ResolutionSummary;
  remainingTimeMs?: () => number;
};

async function run(opts: RunOptions) {
  const order: string[] = [];
  const source = new FakeSource(opts.rows, order);
  source.lastResolution = opts.resolution;
  const webhooks = new FakeWebhookProvider(opts.endpoints ?? [FILLER_A, FILLER_B]);
  const timestamps = new FakeTimestampRepository(new Map(), order);
  const { metrics, calls, units } = recordingMetrics();
  const { log, records } = recordingLog();
  const addresses = opts.addresses ?? (await fillerAddresses());
  const deps: FadeRateCronDeps = {
    source,
    webhookProvider: webhooks,
    fillerAddressRepo: addresses,
    timestampDB: timestamps,
    now: () => NOW,
    log,
    remainingTimeMs: opts.remainingTimeMs,
  };
  await runFadeRateCron(metrics, deps);
  return { source, webhooks, timestamps, calls, units, records, order, addresses };
}

describe('runFadeRateCron', () => {
  it('scores the source rows and writes the decisions', async () => {
    const r = await run({ rows: BLOCKING_ROWS });

    expect(r.source.calls).toBe(1);
    expect(r.webhooks.fetched).toBe(1);
    expect(r.order).toEqual(['fetch', 'write']);
    expect(r.timestamps.writes).toEqual([BLOCK_A_DECISIONS]);
    expect(r.calls[Metric.CIRCUIT_BREAKER_V2_NEW_BLOCKS]).toEqual([1]);
    expect(r.calls[Metric.CIRCUIT_BREAKER_V2_ACTIVE_BLOCKS]).toEqual([1]);
    expect(r.calls[Metric.CIRCUIT_BREAKER_V2_FILLERS_EVALUATED]).toEqual([2]);
    // Nothing shadow- or switch-related is emitted any more.
    expect(Object.keys(r.calls).some((k) => k.includes('SHADOW') || k.includes('PRIMARY_IS'))).toBe(false);
  });

  it('a source failure is a cron failure: nothing is written, nothing falls back', async () => {
    const timestamps = new FakeTimestampRepository();
    const { metrics } = recordingMetrics();
    await expect(
      runFadeRateCron(metrics, {
        source: new FakeSource(new Error('order service unavailable')),
        webhookProvider: new FakeWebhookProvider([FILLER_A, FILLER_B]),
        fillerAddressRepo: await fillerAddresses(),
        timestampDB: timestamps,
        now: () => NOW,
      })
    ).rejects.toThrow('order service unavailable');
    expect(timestamps.writes).toEqual([]);
  });

  it('skips the write when there is nothing to update', async () => {
    const r = await run({
      rows: [row('0x00000000000000000000000000000000000000C1', 1, NOW - 10)],
      endpoints: [FILLER_A],
    });
    expect(r.timestamps.writes).toEqual([]);
  });

  describe('filler attribution', () => {
    it('resolves fillers by the addresses in the rows and drops mappings to endpoints no longer configured', async () => {
      const ADDR_C = '0x00000000000000000000000000000000000000C1';
      const addresses = await fillerAddresses();
      await addresses.recordWinningAddress(ADDR_C, 'https://removed.example/rfq');
      const rows = [...BLOCKING_ROWS, ...Array.from({ length: 5 }, (_, i) => row(ADDR_C, 1, NOW - 100 - i))];

      const r = await run({ rows, addresses });

      // exactly the distinct addresses in the rows were looked up (no per-endpoint scan)
      expect(r.addresses.requestedAddresses).toEqual([[ADDR_A, ADDR_B, ADDR_C]]);
      // ADDR_C's filler is not in the webhook config, so its fades bench nobody
      expect(r.timestamps.writes.flat().map((w) => w.hash)).toEqual([FILLER_A, FILLER_B]);
    });
  });

  describe('order-service resolution health metrics', () => {
    it('are emitted from the source summary', async () => {
      const r = await run({ rows: BLOCKING_ROWS, resolution: RESOLUTION });
      expect(r.calls[Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_PENDING_PAST_DEADLINE]).toEqual([7]);
      expect(r.calls[Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_PENDING_SATURATED]).toEqual([0]);
      expect(r.calls[Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_RESOLVED]).toEqual([5]);
      expect(r.calls[Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_STILL_OPEN]).toEqual([1]);
      expect(r.calls[Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_FILLS_WITHOUT_VERDICT]).toEqual([1]);
      expect(r.calls[Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_GIVEN_UP]).toEqual([0]);
      expect(r.calls[Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_FAILED_WRITES]).toEqual([0]);
    });

    it('are absent when the source produced no summary', async () => {
      const r = await run({ rows: BLOCKING_ROWS });
      expect(Object.keys(r.calls).some((k) => k.includes('ORDER_RESOLUTION'))).toBe(false);
    });
  });

  describe('time budget against the Lambda deadline', () => {
    it('leaves the source unbudgeted without a remaining-time source', async () => {
      const r = await run({ rows: BLOCKING_ROWS });
      expect(r.source.deadlineMs).toBeUndefined();
    });

    it('bounds best-effort resolution to the remaining time minus the exit margin', async () => {
      const remaining = 200_000;
      const before = Date.now();
      const r = await run({ rows: BLOCKING_ROWS, remainingTimeMs: () => remaining });
      expect(r.source.deadlineMs).toBeGreaterThanOrEqual(before + remaining - LAMBDA_EXIT_MARGIN_MS);
      expect(r.source.deadlineMs).toBeLessThanOrEqual(Date.now() + remaining - LAMBDA_EXIT_MARGIN_MS);
      expect(r.timestamps.writes).toEqual([BLOCK_A_DECISIONS]);
    });

    it('never sets a deadline in the past', async () => {
      const before = Date.now();
      const r = await run({ rows: BLOCKING_ROWS, remainingTimeMs: () => 1_000 });
      expect(r.source.deadlineMs).toBeGreaterThanOrEqual(before);
    });
  });

  describe('observability', () => {
    it("hands the webhook config refresh the run's own ctx, so a config change lands in the run's metrics", async () => {
      const r = await run({ rows: BLOCKING_ROWS });

      expect(r.webhooks.fetched).toBe(1);
      expect(r.calls[Metric.RFQ_CONFIG_CHANGED]).toEqual([1]);
      expect(r.webhooks.ctx?.requestId).toEqual(expect.any(String));
      // The ctx logger writes through the run's logger.
      r.webhooks.ctx?.logger.info('from the refresh');
      expect(r.records.find((rec) => rec.msg === 'from the refresh')).toBeDefined();
    });
  });

  describe('EMF output', () => {
    // CircuitBreakerBL emits through the Metrics interface; the adapter's EmfMetrics must turn
    // that back into the exact (name, unit) series the dashboards and alarms read.
    it('emits run counters as Count and per-filler rates as None', async () => {
      const r = await run({ rows: BLOCKING_ROWS, resolution: RESOLUTION });

      for (const name of [
        Metric.CIRCUIT_BREAKER_V2_ACTIVE_BLOCKS,
        Metric.CIRCUIT_BREAKER_V2_FILLERS_EVALUATED,
        Metric.CIRCUIT_BREAKER_V2_NEW_BLOCKS,
        Metric.CIRCUIT_BREAKER_V2_EXTENDED_BLOCKS,
        Metric.CIRCUIT_BREAKER_V2_SATURATED_ADDRESSES,
        Metric.CIRCUIT_BREAKER_ORDER_RESOLUTION_RESOLVED,
        metricContext(Metric.CIRCUIT_BREAKER_V2_CONSECUTIVE_BLOCKS, FILLER_A),
      ]) {
        expect([name, [...(r.units[name] ?? [])]]).toEqual([name, [Unit.Count]]);
      }
      for (const hash of [FILLER_A, FILLER_B]) {
        const name = metricContext(Metric.CIRCUIT_BREAKER_V2_FADE_RATE, hash);
        expect([name, [...(r.units[name] ?? [])]]).toEqual([name, [Unit.None]]);
      }
    });
  });

  describe('logging', () => {
    it('logs row counts, not the rows themselves', async () => {
      const r = await run({ rows: BLOCKING_ROWS });
      const stats = r.records.find((rec) => rec.msg === 'getFillersFadeStats');
      expect(stats).toMatchObject({ rowCount: BLOCKING_ROWS.length, fadeCount: 5 });
      expect(stats).not.toHaveProperty('rows');
    });
  });
});
