import { createMetricsLogger, MetricsLogger, Unit } from 'aws-embedded-metrics';
import Logger from 'bunyan';

import { ShadowContext } from '../../lib/cron/fade-rate-shadow';
import { BASE_BLOCK_SECS, FadeRateCronDeps, runFadeRateCron } from '../../lib/cron/fade-rate-v2';
import { Metric } from '../../lib/entities';
import {
  BaseTimestampRepository,
  TimestampRepoRow,
  ToUpdateTimestampRow,
  V2FadesRowType,
} from '../../lib/repositories';
import { MockFillerAddressRepository } from '../../lib/repositories/filler-address-repository';
import { UNBLOCKED_BLOCK_UNTIL_TIMESTAMP } from '../../lib/repositories/timestamp-repository';

const log = Logger.createLogger({ name: 'test' });
log.level(Logger.FATAL);

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

// Redshift stand-in: the rows the real path scores, plus a call log proving the view is built.
class FakeFadesRepository {
  public calls: string[] = [];
  constructor(private readonly rows: V2FadesRowType[]) {}
  async createFadesView(): Promise<void> {
    this.calls.push('createFadesView');
  }
  async getFades(): Promise<V2FadesRowType[]> {
    this.calls.push('getFades');
    return this.rows;
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
  constructor(private readonly stored: Map<string, Omit<TimestampRepoRow, 'hash'>> = new Map()) {}
  async updateTimestampsBatch(toUpdate: ToUpdateTimestampRow[]): Promise<void> {
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

// Filler A fades 5 of 5 (blocks); filler B fills 5 of 5 (stays clear).
const ROWS: V2FadesRowType[] = [
  ...Array.from({ length: 5 }, (_, i) => row(ADDR_A, 1, NOW - 100 - i)),
  ...Array.from({ length: 5 }, (_, i) => row(ADDR_B, 0, NOW - 100 - i)),
];

async function fillerAddresses(): Promise<MockFillerAddressRepository> {
  const repo = new MockFillerAddressRepository();
  await repo.recordWinningAddress(ADDR_A, FILLER_A);
  await repo.recordWinningAddress(ADDR_B, FILLER_B);
  return repo;
}

async function run(shadow?: FadeRateCronDeps['shadow']) {
  const fades = new FakeFadesRepository(ROWS);
  const webhooks = new FakeWebhookProvider([FILLER_A, FILLER_B]);
  const timestamps = new FakeTimestampRepository();
  const { metrics, calls } = recordingMetrics();
  await runFadeRateCron(metrics, {
    fadesRepository: fades,
    webhookProvider: webhooks,
    fillerAddressRepo: await fillerAddresses(),
    timestampDB: timestamps,
    shadow,
    now: () => NOW,
    log,
  });
  return { fades, webhooks, timestamps, calls };
}

describe('runFadeRateCron', () => {
  it('runs the Redshift path end to end: builds the view, scores, and writes the decisions', async () => {
    const { fades, webhooks, timestamps, calls } = await run();

    expect(fades.calls).toEqual(['createFadesView', 'getFades']);
    expect(webhooks.fetched).toBe(1);
    expect(timestamps.writes).toHaveLength(1);
    expect(timestamps.writes[0]).toEqual([
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
    ]);
    expect(calls[Metric.CIRCUIT_BREAKER_V2_NEW_BLOCKS]).toEqual([1]);
    expect(calls[Metric.CIRCUIT_BREAKER_V2_ACTIVE_BLOCKS]).toEqual([1]);
    expect(calls[Metric.CIRCUIT_BREAKER_V2_FILLERS_EVALUATED]).toEqual([2]);
  });

  it('the Redshift path writes and metrics are identical with a shadow, without one, and with a throwing shadow', async () => {
    const baseline = await run();
    const withShadow = await run(async () => undefined);
    const withThrowingShadow = await run(async () => {
      throw new Error('order service exploded');
    });
    const withRejectingShadow = await run(() => Promise.reject(new TypeError('classification bug')));

    for (const variant of [withShadow, withThrowingShadow, withRejectingShadow]) {
      expect(variant.timestamps.writes).toEqual(baseline.timestamps.writes);
      expect(variant.fades.calls).toEqual(baseline.fades.calls);
      // Every real-path metric is the same; the throwing variants add exactly the failure marker.
      const { [Metric.CIRCUIT_BREAKER_SHADOW_FAILURE]: failure, ...realPathMetrics } = variant.calls;
      expect(realPathMetrics).toEqual(baseline.calls);
      expect(failure ?? []).toEqual(variant === withShadow ? [] : [1]);
    }
    expect(baseline.calls[Metric.CIRCUIT_BREAKER_SHADOW_FAILURE]).toBeUndefined();
  });

  it('resolves fillers by the addresses in the rows and drops mappings to endpoints no longer configured', async () => {
    const ADDR_C = '0x00000000000000000000000000000000000000C1';
    const REMOVED_FILLER = 'https://removed.example/rfq';
    const addresses = await fillerAddresses();
    await addresses.recordWinningAddress(ADDR_C, REMOVED_FILLER);
    const rows = [...ROWS, ...Array.from({ length: 5 }, (_, i) => row(ADDR_C, 1, NOW - 100 - i))];
    const timestamps = new FakeTimestampRepository();
    const { metrics } = recordingMetrics();

    await runFadeRateCron(metrics, {
      fadesRepository: new FakeFadesRepository(rows),
      webhookProvider: new FakeWebhookProvider([FILLER_A, FILLER_B]),
      fillerAddressRepo: addresses,
      timestampDB: timestamps,
      now: () => NOW,
      log,
    });

    // exactly the distinct addresses in the rows were looked up (no per-endpoint scan)
    expect(addresses.requestedAddresses).toEqual([[ADDR_A, ADDR_B, ADDR_C]]);
    // ADDR_C's filler is not in the webhook config, so its fades bench nobody
    const written = timestamps.writes.flat().map((w) => w.hash);
    expect(written).toEqual([FILLER_A, FILLER_B]);
  });

  it('a throwing shadow does not fail the cron', async () => {
    await expect(
      run(async () => {
        throw new Error('boom');
      })
    ).resolves.toBeDefined();
  });

  it('invokes the shadow only after the real decisions are written, with those decisions and the rows', async () => {
    const order: string[] = [];
    let received: ShadowContext | undefined;
    const fades = new FakeFadesRepository(ROWS);
    const timestamps = new FakeTimestampRepository();
    const realWrite = timestamps.updateTimestampsBatch.bind(timestamps);
    timestamps.updateTimestampsBatch = async (rows) => {
      order.push('write');
      return realWrite(rows);
    };
    const { metrics } = recordingMetrics();

    await runFadeRateCron(metrics, {
      fadesRepository: fades,
      webhookProvider: new FakeWebhookProvider([FILLER_A, FILLER_B]),
      fillerAddressRepo: await fillerAddresses(),
      timestampDB: timestamps,
      shadow: async (ctx) => {
        order.push('shadow');
        received = ctx;
      },
      now: () => NOW,
      log,
    });

    expect(order).toEqual(['write', 'shadow']);
    expect(received?.redshiftRows).toEqual(ROWS);
    expect(received?.realUpdates).toEqual(timestamps.writes[0]);
    expect(received?.now).toBe(NOW);
    // The scorer the shadow gets is the production scoring closed over the same stored state:
    // re-scoring the Redshift rows reproduces the real decisions exactly, and scoring a clean
    // set produces no block — while the write log still shows exactly one real write.
    expect(received?.score(ROWS)).toEqual(timestamps.writes[0]);
    const clean = received?.score(ROWS.map((r) => ({ ...r, faded: 0 })));
    expect(clean?.every((r) => r.blockUntilTimestamp === UNBLOCKED_BLOCK_UNTIL_TIMESTAMP)).toBe(true);
    expect(timestamps.writes).toHaveLength(1);
  });

  it('the shadow context carries no handle to the timestamp repository', async () => {
    let received: ShadowContext | undefined;
    await run(async (ctx) => {
      received = ctx;
    });
    expect(Object.keys(received ?? {}).sort()).toEqual(['now', 'realUpdates', 'redshiftRows', 'score']);
  });

  it('skips the write and still runs the shadow when there is nothing to update', async () => {
    let shadowRan = false;
    const timestamps = new FakeTimestampRepository();
    const { metrics } = recordingMetrics();
    await runFadeRateCron(metrics, {
      fadesRepository: new FakeFadesRepository([row('0x00000000000000000000000000000000000000C1', 1, NOW - 10)]),
      webhookProvider: new FakeWebhookProvider([FILLER_A]),
      fillerAddressRepo: await fillerAddresses(),
      timestampDB: timestamps,
      shadow: async () => {
        shadowRan = true;
      },
      now: () => NOW,
      log,
    });
    expect(timestamps.writes).toEqual([]);
    expect(shadowRan).toBe(true);
  });
});
