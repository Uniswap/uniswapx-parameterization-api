import { createMetricsLogger, MetricsLogger, Unit } from 'aws-embedded-metrics';
import Logger from 'bunyan';

import { BASE_BLOCK_SECS, FadeRateCronDeps, runFadeRateCron } from '../../lib/cron/fade-rate-v2';
import { FadesScoringSource, FadesSourceKind } from '../../lib/cron/fades-sources';
import { Metric } from '../../lib/entities';
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

// A fades source in either role: canned rows or an error, and a call log with timing order.
class FakeSource implements FadesScoringSource {
  public calls = 0;
  public deadlineMs?: number;
  constructor(
    public readonly kind: FadesSourceKind,
    private readonly rows: V2FadesRowType[] | Error,
    private readonly order?: string[]
  ) {}
  async fetchRows(): Promise<V2FadesRowType[]> {
    this.calls += 1;
    this.order?.push(`fetch:${this.kind}`);
    if (this.rows instanceof Error) throw this.rows;
    return this.rows;
  }
  setDeadline(deadlineMs: number): void {
    this.deadlineMs = deadlineMs;
  }
}

class FakeWebhookProvider {
  public fetched = 0;
  constructor(private readonly endpoints: string[]) {}
  async fetchEndpoints(): Promise<void> {
    this.fetched += 1;
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
  properties: Record<string, unknown>;
} {
  const metrics = createMetricsLogger();
  const calls: Record<string, number[]> = {};
  const properties: Record<string, unknown> = {};
  const originalPut = metrics.putMetric.bind(metrics);
  metrics.putMetric = (key: string, value: number, unit?: Unit | string) => {
    (calls[key] ??= []).push(value);
    return originalPut(key, value, unit);
  };
  const originalProp = metrics.setProperty.bind(metrics);
  metrics.setProperty = (key: string, value: unknown) => {
    properties[key] = value;
    return originalProp(key, value);
  };
  return { metrics, calls, properties };
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
// Everybody clean.
const CLEAN_ROWS: V2FadesRowType[] = BLOCKING_ROWS.map((r) => ({ ...r, faded: 0 }));

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
const ALL_CLEAN_DECISIONS: ToUpdateTimestampRow[] = BLOCK_A_DECISIONS.map((d) => ({
  ...d,
  blockUntilTimestamp: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
  fadeWindowStart: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
  consecutiveBlocks: 0,
}));

async function fillerAddresses(): Promise<MockFillerAddressRepository> {
  const repo = new MockFillerAddressRepository();
  await repo.recordWinningAddress(ADDR_A, FILLER_A);
  await repo.recordWinningAddress(ADDR_B, FILLER_B);
  return repo;
}

type RunOptions = {
  primary: FadesSourceKind;
  redshift: V2FadesRowType[] | Error;
  orderService?: V2FadesRowType[] | Error | 'absent';
  addresses?: MockFillerAddressRepository;
  endpoints?: string[];
};

async function run(opts: RunOptions) {
  const order: string[] = [];
  const redshift = new FakeSource('redshift', opts.redshift, order);
  const orderService =
    opts.orderService === 'absent' || opts.orderService === undefined
      ? undefined
      : new FakeSource('order-service', opts.orderService, order);
  const webhooks = new FakeWebhookProvider(opts.endpoints ?? [FILLER_A, FILLER_B]);
  const timestamps = new FakeTimestampRepository(new Map(), order);
  const { metrics, calls, properties } = recordingMetrics();
  const { log, records } = recordingLog();
  const addresses = opts.addresses ?? (await fillerAddresses());
  const deps: FadeRateCronDeps = {
    primary: opts.primary,
    redshift,
    orderService,
    webhookProvider: webhooks,
    fillerAddressRepo: addresses,
    timestampDB: timestamps,
    now: () => NOW,
    log,
    shadowCompareSince: 0,
  };
  const result = await runFadeRateCron(metrics, deps);
  return { result, redshift, orderService, webhooks, timestamps, calls, properties, records, order, addresses };
}

describe('runFadeRateCron', () => {
  describe('primary = order-service (the default)', () => {
    it('writes the decisions computed from the order-service rows; Redshift only shadows', async () => {
      const r = await run({ primary: 'order-service', orderService: BLOCKING_ROWS, redshift: CLEAN_ROWS });

      expect(r.timestamps.writes).toEqual([BLOCK_A_DECISIONS]);
      expect(r.orderService?.calls).toBe(1);
      expect(r.redshift.calls).toBe(1);
      expect(r.webhooks.fetched).toBe(1);
      // The shadow (Redshift) disagreed — it saw no fades — yet nothing it did reached the table.
      expect(r.calls[Metric.CIRCUIT_BREAKER_V2_NEW_BLOCKS]).toEqual([1]);
      expect(r.calls[Metric.CIRCUIT_BREAKER_V2_ACTIVE_BLOCKS]).toEqual([1]);
      expect(r.calls[Metric.CIRCUIT_BREAKER_SHADOW_SUCCESS]).toEqual([1]);
      expect(r.calls[Metric.CIRCUIT_BREAKER_SHADOW_DECISION_DISAGREE]).toEqual([1]);
      expect(r.calls[Metric.CIRCUIT_BREAKER_SHADOW_WOULD_BLOCK]).toEqual([0]);
    });

    it('runs the Redshift shadow only after the primary decisions are written, under a deadline', async () => {
      const r = await run({ primary: 'order-service', orderService: BLOCKING_ROWS, redshift: CLEAN_ROWS });
      expect(r.order).toEqual(['fetch:order-service', 'write', 'fetch:redshift']);
      // The shadow, whichever it is, is handed the budget deadline; the primary never is.
      expect(r.redshift.deadlineMs).toBeDefined();
      expect(r.orderService?.deadlineMs).toBeUndefined();
    });

    it('a Redshift shadow failure (e.g. endpoint not connectable) leaves the primary writes intact and does not fail the cron', async () => {
      const failing = await run({
        primary: 'order-service',
        orderService: BLOCKING_ROWS,
        redshift: new Error('Redshift endpoint is not connectable'),
      });
      const healthy = await run({ primary: 'order-service', orderService: BLOCKING_ROWS, redshift: BLOCKING_ROWS });

      expect(failing.timestamps.writes).toEqual(healthy.timestamps.writes);
      expect(failing.timestamps.writes).toEqual([BLOCK_A_DECISIONS]);
      expect(failing.calls[Metric.CIRCUIT_BREAKER_SHADOW_FAILURE]).toEqual([1]);
      expect(failing.calls[Metric.CIRCUIT_BREAKER_SHADOW_SUCCESS]).toBeUndefined();
      // Every primary-path metric is identical between the two runs.
      const primaryMetrics = (calls: Record<string, number[]>) =>
        Object.fromEntries(Object.entries(calls).filter(([k]) => !k.startsWith('CIRCUIT_BREAKER_SHADOW_')));
      expect(primaryMetrics(failing.calls)).toEqual(primaryMetrics(healthy.calls));
    });

    it('a primary (order-service) failure is a real cron failure: nothing is written', async () => {
      const timestamps = new FakeTimestampRepository();
      const { metrics } = recordingMetrics();
      await expect(
        runFadeRateCron(metrics, {
          primary: 'order-service',
          orderService: new FakeSource('order-service', new Error('order service unavailable')),
          redshift: new FakeSource('redshift', CLEAN_ROWS),
          webhookProvider: new FakeWebhookProvider([FILLER_A, FILLER_B]),
          fillerAddressRepo: await fillerAddresses(),
          timestampDB: timestamps,
          now: () => NOW,
        })
      ).rejects.toThrow('order service unavailable');
      expect(timestamps.writes).toEqual([]);
    });

    it('refuses to run with the order-service primary unavailable rather than silently using Redshift', async () => {
      const timestamps = new FakeTimestampRepository();
      const redshift = new FakeSource('redshift', BLOCKING_ROWS);
      const { metrics } = recordingMetrics();
      await expect(
        runFadeRateCron(metrics, {
          primary: 'order-service',
          redshift,
          webhookProvider: new FakeWebhookProvider([FILLER_A, FILLER_B]),
          fillerAddressRepo: await fillerAddresses(),
          timestampDB: timestamps,
          now: () => NOW,
        })
      ).rejects.toThrow(/order-service/);
      expect(redshift.calls).toBe(0);
      expect(timestamps.writes).toEqual([]);
    });
  });

  describe('primary = redshift (the revert position)', () => {
    it('writes the decisions computed from the Redshift rows; the order service only shadows', async () => {
      const r = await run({ primary: 'redshift', redshift: BLOCKING_ROWS, orderService: CLEAN_ROWS });

      expect(r.timestamps.writes).toEqual([BLOCK_A_DECISIONS]);
      expect(r.order).toEqual(['fetch:redshift', 'write', 'fetch:order-service']);
      expect(r.orderService?.deadlineMs).toBeDefined();
      expect(r.calls[Metric.CIRCUIT_BREAKER_SHADOW_SUCCESS]).toEqual([1]);
      expect(r.calls[Metric.CIRCUIT_BREAKER_SHADOW_DECISION_DISAGREE]).toEqual([1]);
    });

    it('an order-service shadow failure leaves the Redshift writes intact', async () => {
      const r = await run({ primary: 'redshift', redshift: BLOCKING_ROWS, orderService: new Error('timeout') });
      expect(r.timestamps.writes).toEqual([BLOCK_A_DECISIONS]);
      expect(r.calls[Metric.CIRCUIT_BREAKER_SHADOW_FAILURE]).toEqual([1]);
    });

    it('a Redshift primary failure is a real cron failure', async () => {
      await expect(
        run({
          primary: 'redshift',
          redshift: new Error('Redshift endpoint is not connectable'),
          orderService: CLEAN_ROWS,
        })
      ).rejects.toThrow('not connectable');
    });

    it('runs without any shadow when the order service is not configured', async () => {
      const r = await run({ primary: 'redshift', redshift: CLEAN_ROWS, orderService: 'absent' });
      expect(r.timestamps.writes).toEqual([ALL_CLEAN_DECISIONS]);
      expect(Object.keys(r.calls).some((k) => k.startsWith('CIRCUIT_BREAKER_SHADOW_'))).toBe(false);
    });
  });

  describe('filler attribution', () => {
    const ADDR_C = '0x00000000000000000000000000000000000000C1';
    const FILLER_C = 'https://filler-c.example/rfq';
    const rowsWithC = (rows: V2FadesRowType[]) => [
      ...rows,
      ...Array.from({ length: 5 }, (_, i) => row(ADDR_C, 1, NOW - 100 - i)),
    ];

    it('resolves fillers by the addresses in the primary rows and drops mappings to endpoints no longer configured', async () => {
      const addresses = await fillerAddresses();
      await addresses.recordWinningAddress(ADDR_C, 'https://removed.example/rfq');

      const r = await run({
        primary: 'order-service',
        orderService: rowsWithC(BLOCKING_ROWS),
        redshift: CLEAN_ROWS,
        addresses,
      });

      // exactly the distinct addresses in the rows were looked up (no per-endpoint scan)
      expect(r.addresses.requestedAddresses[0]).toEqual([ADDR_A, ADDR_B, ADDR_C]);
      // ADDR_C's filler is not in the webhook config, so its fades bench nobody
      expect(r.timestamps.writes.flat().map((w) => w.hash)).toEqual([FILLER_A, FILLER_B]);
    });

    it("the shadow's scorer resolves addresses its rows name that the primary rows do not", async () => {
      // A filler whose only orders the primary source has not seen: its address is absent from
      // the primary rows, so the primary run never looked it up. The shadow's rows do carry it,
      // and its 5/5 fades must produce a would-block decision, not vanish for want of a mapping.
      const addresses = await fillerAddresses();
      await addresses.recordWinningAddress(ADDR_C, FILLER_C);

      const r = await run({
        primary: 'order-service',
        orderService: BLOCKING_ROWS,
        redshift: rowsWithC(BLOCKING_ROWS),
        addresses,
        endpoints: [FILLER_A, FILLER_B, FILLER_C],
      });

      // Primary looked up exactly its own addresses; the shadow added exactly the one it lacked,
      // once per scoring pass (its rows are scored in full and again above the comparison floor).
      expect(r.addresses.requestedAddresses).toEqual([[ADDR_A, ADDR_B], [ADDR_C], [ADDR_C]]);
      const report = r.records.find((rec) => rec.msg === 'fade circuit breaker shadow report') as
        | { decisionsVsProduction: { onlyShadow: string[] }; wouldBlock: number }
        | undefined;
      expect(report?.decisionsVsProduction.onlyShadow).toEqual([FILLER_C]);
      expect(report?.wouldBlock).toBe(2);
      // and nothing about C reached the table
      expect(r.timestamps.writes.flat().map((w) => w.hash)).toEqual([FILLER_A, FILLER_B]);
    });
  });

  describe('the two positions are symmetric', () => {
    it('the same rows produce the same writes whichever source supplies them', async () => {
      const viaOrderService = await run({
        primary: 'order-service',
        orderService: BLOCKING_ROWS,
        redshift: CLEAN_ROWS,
      });
      const viaRedshift = await run({ primary: 'redshift', redshift: BLOCKING_ROWS, orderService: CLEAN_ROWS });
      expect(viaOrderService.timestamps.writes).toEqual(viaRedshift.timestamps.writes);
      expect(viaOrderService.calls[Metric.CIRCUIT_BREAKER_V2_NEW_BLOCKS]).toEqual(
        viaRedshift.calls[Metric.CIRCUIT_BREAKER_V2_NEW_BLOCKS]
      );
    });
  });

  describe('observability', () => {
    it.each<FadesSourceKind>(['order-service', 'redshift'])(
      'tags the run with the primary source: %s',
      async (primary) => {
        const r = await run({ primary, orderService: BLOCKING_ROWS, redshift: BLOCKING_ROWS });

        expect(r.properties.fadesSource).toBe(primary);
        expect(r.calls[Metric.CIRCUIT_BREAKER_PRIMARY_IS_ORDER_SERVICE]).toEqual([primary === 'order-service' ? 1 : 0]);
        // Every block-decision log line carries the source; the shadow's lines say so too.
        const blockLines = r.records.filter((rec) => String(rec.msg).startsWith('Blocking filler'));
        expect(blockLines.length).toBeGreaterThan(0);
        expect(blockLines.every((rec) => rec.fadesSource === primary && rec.shadow === undefined)).toBe(true);
        const shadowReport = r.records.find((rec) => rec.msg === 'fade circuit breaker shadow report');
        expect(shadowReport).toMatchObject({
          fadesSource: primary,
          primary,
          shadow: primary === 'order-service' ? 'redshift' : 'order-service',
        });
      }
    );
  });
});
