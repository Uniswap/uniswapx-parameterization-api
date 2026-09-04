import {
  DescribeStatementCommand,
  ExecuteStatementCommand,
  GetStatementResultCommand,
  RedshiftDataClient,
} from '@aws-sdk/client-redshift-data';
import { OrderType, PERMISSIONED_TOKENS } from '@uniswap/uniswapx-sdk';
import Logger from 'bunyan';

import {
  buildFadeRows,
  Classification,
  classifyOutcome,
  EXCLUDED_TESTNET_CHAIN_IDS,
  FADE_WINDOW_SECS,
  fadedForScoring,
  MAX_CONSECUTIVE_BATCH_FAILURES,
  MAX_PENDING_RESOLUTIONS_PER_RUN,
  ORDER_STATUS,
  OrderServiceFadesSource,
} from '../../lib/cron/order-service-fades-source';
import { MockOrderStatusProvider, OrderServiceOrderStatus } from '../../lib/providers/order';
import { ORDER_SERVICE_MAX_ORDER_HASHES } from '../../lib/providers/order/uniswapxService';
import { ORDERS_PER_FILLER_LIMIT, V2FadesRepository, V2FadesRowType } from '../../lib/repositories/fades-repository';
import {
  MockPostedOrderRepository,
  PostedOrderOutcome,
  PostedOrderRecord,
} from '../../lib/repositories/posted-order-repository';

const log = Logger.createLogger({ name: 'test' });
log.level(Logger.FATAL);

const NOW = 1_800_000_000;
const FILLER_A = 'https://filler-a.example/rfq';
const FILLER_B = 'https://filler-b.example/rfq';
const ADDR_A = '0x00000000000000000000000000000000000000A1';
const ADDR_A2 = '0x00000000000000000000000000000000000000A2';
const ADDR_B = '0x00000000000000000000000000000000000000B1';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const DECAY_START_TIME = NOW - 3_000;
const DECAY_START_BLOCK = 20_000_000;

let hashCounter = 0;
const nextHash = () => `0x${(++hashCounter).toString(16).padStart(64, '0')}`;

const v2 = (overrides: Partial<PostedOrderRecord> = {}): PostedOrderRecord => ({
  orderHash: nextHash(),
  quoteId: 'quote',
  requestId: 'request',
  chainId: 1,
  orderType: OrderType.Dutch_V2,
  fillerAddress: ADDR_A,
  filler: FILLER_A,
  fillerName: 'filler-a',
  decayStartTime: DECAY_START_TIME,
  deadline: NOW - 2_000,
  tokenIn: USDC,
  tokenOut: WETH,
  postedAt: NOW - 3_100,
  outcome: PostedOrderOutcome.PENDING,
  ...overrides,
});
const v3 = (overrides: Partial<PostedOrderRecord> = {}): PostedOrderRecord =>
  v2({ orderType: OrderType.Dutch_V3, decayStartTime: undefined, decayStartBlock: DECAY_START_BLOCK, ...overrides });

const status = (orderHash: string, orderStatus: string, timing: Partial<OrderServiceOrderStatus> = {}) => ({
  orderHash,
  orderStatus,
  ...timing,
});

// A resolved record: what recordOutcome leaves behind for a given status.
const resolved = (record: PostedOrderRecord, s: OrderServiceOrderStatus): PostedOrderRecord => {
  const classification = classifyOutcome(record, s, NOW);
  if (classification.kind !== 'resolved') throw new Error(`fixture is not resolvable: ${classification.kind}`);
  const { outcome, orderStatus, fillBlock, fillTimestamp, faded, resolvedAt } = classification.resolution;
  return {
    ...record,
    outcome,
    orderStatus,
    resolvedAt,
    ...(fillBlock !== undefined && { fillBlock }),
    ...(fillTimestamp !== undefined && { fillTimestamp }),
    ...(faded !== undefined && { faded }),
  };
};

describe('OrderServiceFadesSource', () => {
  describe('classifyOutcome (status x order type x timing)', () => {
    type Case = {
      name: string;
      record: PostedOrderRecord;
      status: OrderServiceOrderStatus;
      expected: Classification['kind'];
      outcome?: PostedOrderOutcome;
      faded?: number;
    };
    const cases: Case[] = [
      // Dutch_V2 fills decay by wallclock: only a fill strictly after decayStartTime fades.
      {
        name: 'V2 filled before decay start -> clean',
        record: v2(),
        status: status('h', ORDER_STATUS.FILLED, { fillTimestamp: DECAY_START_TIME - 1, fillBlock: 1 }),
        expected: 'resolved',
        outcome: PostedOrderOutcome.FILLED,
        faded: 0,
      },
      {
        name: 'V2 filled AT decay start -> clean (undecayed price)',
        record: v2(),
        status: status('h', ORDER_STATUS.FILLED, { fillTimestamp: DECAY_START_TIME, fillBlock: 1 }),
        expected: 'resolved',
        outcome: PostedOrderOutcome.FILLED,
        faded: 0,
      },
      {
        name: 'V2 filled after decay start -> fade',
        record: v2(),
        status: status('h', ORDER_STATUS.FILLED, { fillTimestamp: DECAY_START_TIME + 1, fillBlock: 1 }),
        expected: 'resolved',
        outcome: PostedOrderOutcome.FILLED,
        faded: 1,
      },
      {
        name: 'V2 filled without fillTimestamp -> unclassifiable',
        record: v2(),
        status: status('h', ORDER_STATUS.FILLED, { fillBlock: 1 }),
        expected: 'unclassifiable',
      },
      // Dutch_V3 fills decay by block: fillTimeBlocks = fillBlock - decayStartBlock must be > 0.
      {
        name: 'V3 filled before decay start block -> clean',
        record: v3(),
        status: status('h', ORDER_STATUS.FILLED, { fillBlock: DECAY_START_BLOCK - 1, fillTimestamp: NOW }),
        expected: 'resolved',
        outcome: PostedOrderOutcome.FILLED,
        faded: 0,
      },
      {
        name: 'V3 filled AT decay start block -> clean (fillTimeBlocks = 0 is not a fade)',
        record: v3(),
        status: status('h', ORDER_STATUS.FILLED, { fillBlock: DECAY_START_BLOCK, fillTimestamp: NOW }),
        expected: 'resolved',
        outcome: PostedOrderOutcome.FILLED,
        faded: 0,
      },
      {
        name: 'V3 filled one block after decay start -> fade',
        record: v3(),
        status: status('h', ORDER_STATUS.FILLED, { fillBlock: DECAY_START_BLOCK + 1, fillTimestamp: NOW }),
        expected: 'resolved',
        outcome: PostedOrderOutcome.FILLED,
        faded: 1,
      },
      {
        name: 'V3 fill timing ignores fillTimestamp (late timestamp, on-time block) -> clean',
        record: v3(),
        status: status('h', ORDER_STATUS.FILLED, { fillBlock: DECAY_START_BLOCK, fillTimestamp: NOW + 10_000 }),
        expected: 'resolved',
        outcome: PostedOrderOutcome.FILLED,
        faded: 0,
      },
      {
        name: 'V3 filled without fillBlock -> unclassifiable',
        record: v3(),
        status: status('h', ORDER_STATUS.FILLED, { fillTimestamp: NOW }),
        expected: 'unclassifiable',
      },
      {
        name: 'V3 record missing decayStartBlock -> unclassifiable',
        record: v3({ decayStartBlock: undefined }),
        status: status('h', ORDER_STATUS.FILLED, { fillBlock: DECAY_START_BLOCK + 5 }),
        expected: 'unclassifiable',
      },
      {
        name: 'unknown order type fill -> unclassifiable',
        record: v2({ orderType: 'Priority' }),
        status: status('h', ORDER_STATUS.FILLED, { fillBlock: 1, fillTimestamp: 1 }),
        expected: 'unclassifiable',
      },
      // Never filled.
      {
        name: 'V2 expired -> fade',
        record: v2(),
        status: status('h', ORDER_STATUS.EXPIRED),
        expected: 'resolved',
        outcome: PostedOrderOutcome.EXPIRED,
        faded: 1,
      },
      {
        name: 'V3 expired -> fade',
        record: v3(),
        status: status('h', ORDER_STATUS.EXPIRED),
        expected: 'resolved',
        outcome: PostedOrderOutcome.EXPIRED,
        faded: 1,
      },
      {
        name: 'cancelled -> recorded without verdict',
        record: v2(),
        status: status('h', ORDER_STATUS.CANCELLED),
        expected: 'resolved',
        outcome: PostedOrderOutcome.CANCELLED,
        faded: undefined,
      },
      {
        name: 'insufficient-funds -> recorded without verdict',
        record: v3(),
        status: status('h', ORDER_STATUS.INSUFFICIENT_FUNDS),
        expected: 'resolved',
        outcome: PostedOrderOutcome.INSUFFICIENT_FUNDS,
        faded: undefined,
      },
      {
        name: 'error -> recorded without verdict',
        record: v2(),
        status: status('h', ORDER_STATUS.ERROR),
        expected: 'resolved',
        outcome: PostedOrderOutcome.ERROR,
        faded: undefined,
      },
      // Not terminal / unknown.
      {
        name: 'open past deadline -> still pending (poller lag)',
        record: v2(),
        status: status('h', ORDER_STATUS.OPEN),
        expected: 'still-open',
      },
      {
        name: 'unknown status string -> unclassifiable',
        record: v2(),
        status: status('h', 'settling'),
        expected: 'unclassifiable',
      },
    ];

    it.each(cases)('$name', ({ record, status, expected, outcome, faded }) => {
      const classification = classifyOutcome(record, status, NOW);
      expect(classification.kind).toBe(expected);
      if (classification.kind === 'resolved') {
        expect(classification.resolution.outcome).toBe(outcome);
        expect(classification.resolution.faded).toBe(faded);
        expect(classification.resolution.orderStatus).toBe(status.orderStatus);
        expect(classification.resolution.resolvedAt).toBe(NOW);
        expect(classification.resolution.fillBlock).toBe(status.fillBlock);
        expect(classification.resolution.fillTimestamp).toBe(status.fillTimestamp);
      }
    });
  });

  describe('fadedForScoring (parity flag)', () => {
    const cancelled = resolved(v2(), status('h', ORDER_STATUS.CANCELLED));
    const insufficient = resolved(v2(), status('h', ORDER_STATUS.INSUFFICIENT_FUNDS));
    const errored = resolved(v2(), status('h', ORDER_STATUS.ERROR));
    const expired = resolved(v2(), status('h', ORDER_STATUS.EXPIRED));
    const cleanFill = resolved(v2(), status('h', ORDER_STATUS.FILLED, { fillTimestamp: DECAY_START_TIME }));

    it('with the flag on, never-filled terminal orders score as fades like the SQL null-fill rows', () => {
      const policy = { countNeverFilledTerminalAsFade: true };
      expect(fadedForScoring(cancelled, policy)).toBe(1);
      expect(fadedForScoring(insufficient, policy)).toBe(1);
      expect(fadedForScoring(errored, policy)).toBe(1);
    });

    it('with the flag off, they contribute no row at all', () => {
      const policy = { countNeverFilledTerminalAsFade: false };
      expect(fadedForScoring(cancelled, policy)).toBeUndefined();
      expect(fadedForScoring(insufficient, policy)).toBeUndefined();
      expect(fadedForScoring(errored, policy)).toBeUndefined();
    });

    it('the flag does not touch definitive outcomes or pending rows', () => {
      for (const flag of [true, false]) {
        const policy = { countNeverFilledTerminalAsFade: flag };
        expect(fadedForScoring(expired, policy)).toBe(1);
        expect(fadedForScoring(cleanFill, policy)).toBe(0);
        expect(fadedForScoring(v2(), policy)).toBeUndefined();
      }
    });
  });

  describe('buildFadeRows (V2_FADE_RATE_SQL semantics)', () => {
    const fade = (overrides: Partial<PostedOrderRecord> = {}) =>
      resolved(v2(overrides), status('h', ORDER_STATUS.EXPIRED));
    const fill = (overrides: Partial<PostedOrderRecord> = {}) =>
      resolved(v2(overrides), status('h', ORDER_STATUS.FILLED, { fillTimestamp: DECAY_START_TIME }));

    it('emits one row per completed, resolved order in the SQL row shape', () => {
      const a = fade({ deadline: NOW - 100, postedAt: NOW - 200 });
      const rows = buildFadeRows([a], { now: NOW });
      expect(rows).toEqual([{ fillerAddress: ADDR_A, faded: 1, postTimestamp: NOW - 200, deadline: NOW - 100 }]);
    });

    it('produces rows with exactly the keys and value types the Redshift repository returns', async () => {
      // Drive the real Redshift formatter through a fake RedshiftDataClient so the shape
      // comparison is against what the cron actually receives today, not a hand-written type.
      V2FadesRepository.log = log;
      const fakeClient = {
        send: async (command: unknown) => {
          if (command instanceof ExecuteStatementCommand) return { Id: 'stmt' };
          if (command instanceof DescribeStatementCommand) return { Status: 'FINISHED' };
          if (command instanceof GetStatementResultCommand) {
            return {
              Records: [
                [
                  { stringValue: ADDR_A },
                  { stringValue: `${NOW - 200}` },
                  { stringValue: `${NOW - 100}` },
                  { longValue: 1 },
                ],
              ],
            };
          }
          throw new Error('unexpected command');
        },
      };
      const redshift = new V2FadesRepository(fakeClient as unknown as RedshiftDataClient, {
        Database: 'db',
        ClusterIdentifier: 'cluster',
        SecretArn: 'arn',
      });
      const [redshiftRow] = await redshift.getFades();
      const [newRow] = buildFadeRows([fade({ deadline: NOW - 100, postedAt: NOW - 200 })], { now: NOW });

      expect(Object.keys(newRow).sort()).toEqual(Object.keys(redshiftRow).sort());
      (Object.keys(redshiftRow) as (keyof V2FadesRowType)[]).forEach((key) => {
        expect(typeof newRow[key]).toBe(typeof redshiftRow[key]);
      });
      expect(newRow).toEqual(redshiftRow);
    });

    it('excludes in-flight orders (deadline >= now)', () => {
      const rows = buildFadeRows([fade({ deadline: NOW }), fade({ deadline: NOW + 60 }), fade({ deadline: NOW - 1 })], {
        now: NOW,
      });
      expect(rows.map((r) => r.deadline)).toEqual([NOW - 1]);
    });

    it('applies the 24h completion window on deadline (inclusive at the start)', () => {
      const atStart = fade({ deadline: NOW - FADE_WINDOW_SECS });
      const before = fade({ deadline: NOW - FADE_WINDOW_SECS - 1 });
      const rows = buildFadeRows([atStart, before], { now: NOW });
      expect(rows.map((r) => r.deadline)).toEqual([atStart.deadline]);
    });

    it('excludes orders with no recorded outcome (still pending)', () => {
      const rows = buildFadeRows([v2(), fill()], { now: NOW });
      expect(rows).toHaveLength(1);
      expect(rows[0].faded).toBe(0);
    });

    it('excludes testnets, the zero filler, missing quoteId and permissioned tokens on either leg', () => {
      const permissioned = PERMISSIONED_TOKENS[0].address;
      const kept = fill();
      const rows = buildFadeRows(
        [
          kept,
          ...EXCLUDED_TESTNET_CHAIN_IDS.map((chainId) => fill({ chainId })),
          fill({ fillerAddress: '0x0000000000000000000000000000000000000000' }),
          fill({ quoteId: '' }),
          fill({ tokenIn: permissioned }),
          fill({ tokenOut: permissioned.toUpperCase().replace('0X', '0x') }),
        ],
        { now: NOW }
      );
      expect(rows).toEqual([
        { fillerAddress: ADDR_A, faded: 0, postTimestamp: kept.postedAt, deadline: kept.deadline },
      ]);
    });

    it('keeps the latest ORDERS_PER_FILLER_LIMIT orders per filler ADDRESS by post time', () => {
      // 100 clean fills posted after one fade: the fade is the 101st most recent and drops out.
      const oldFade = fade({ postedAt: NOW - 50_000, deadline: NOW - 49_000 });
      const fills = Array.from({ length: ORDERS_PER_FILLER_LIMIT }, (_, i) =>
        fill({ postedAt: NOW - 10_000 + i, deadline: NOW - 9_000 + i })
      );
      const rows = buildFadeRows([oldFade, ...fills], { now: NOW });
      expect(rows).toHaveLength(ORDERS_PER_FILLER_LIMIT);
      expect(rows.every((r) => r.faded === 0)).toBe(true);
    });

    it('latest-N is per address, not per filler identity', () => {
      // Two addresses under the same endpoint each get their own 100 slots.
      const a1 = Array.from({ length: ORDERS_PER_FILLER_LIMIT }, (_, i) => fill({ postedAt: NOW - 1_000 + i }));
      const a2Fade = fade({ fillerAddress: ADDR_A2, postedAt: NOW - 50_000, deadline: NOW - 49_000 });
      const rows = buildFadeRows([...a1, a2Fade], { now: NOW });
      expect(rows).toHaveLength(ORDERS_PER_FILLER_LIMIT + 1);
      expect(rows.filter((r) => r.fillerAddress === ADDR_A2)).toEqual([
        { fillerAddress: ADDR_A2, faded: 1, postTimestamp: a2Fade.postedAt, deadline: a2Fade.deadline },
      ]);
    });

    it('latest-N slots are consumed BEFORE the window/token/outcome filters, as in the view', () => {
      // The most recent 100 posts are all permissioned-token or still-pending orders. They take
      // the slots (the view partitions before the join/filters), so the older fade is evicted
      // and nothing is left after filtering.
      const permissioned = PERMISSIONED_TOKENS[0].address;
      const oldFade = fade({ postedAt: NOW - 50_000, deadline: NOW - 49_000 });
      const slotEaters = Array.from({ length: ORDERS_PER_FILLER_LIMIT }, (_, i) =>
        i % 2 === 0 ? fill({ postedAt: NOW - 1_000 + i, tokenIn: permissioned }) : v2({ postedAt: NOW - 1_000 + i })
      );
      expect(buildFadeRows([oldFade, ...slotEaters], { now: NOW })).toEqual([]);
    });

    it('honours the parity flag for never-filled terminal orders', () => {
      const cancelled = resolved(v2(), status('h', ORDER_STATUS.CANCELLED));
      expect(buildFadeRows([cancelled], { now: NOW, policy: { countNeverFilledTerminalAsFade: true } })).toEqual([
        { fillerAddress: ADDR_A, faded: 1, postTimestamp: cancelled.postedAt, deadline: cancelled.deadline },
      ]);
      expect(buildFadeRows([cancelled], { now: NOW, policy: { countNeverFilledTerminalAsFade: false } })).toEqual([]);
    });

    it('orders rows by filler address then deadline desc, like the SQL', () => {
      const rows = buildFadeRows(
        [
          fill({ fillerAddress: ADDR_B, filler: FILLER_B, deadline: NOW - 10 }),
          fill({ deadline: NOW - 30 }),
          fill({ deadline: NOW - 10 }),
          fill({ deadline: NOW - 20 }),
        ],
        { now: NOW }
      );
      expect(rows.map((r) => [r.fillerAddress, r.deadline])).toEqual([
        [ADDR_A, NOW - 10],
        [ADDR_A, NOW - 20],
        [ADDR_A, NOW - 30],
        [ADDR_B, NOW - 10],
      ]);
    });
  });

  describe('resolvePendingOutcomes + getFades', () => {
    let repo: MockPostedOrderRepository;
    let service: MockOrderStatusProvider;
    let source: OrderServiceFadesSource;

    beforeEach(() => {
      repo = new MockPostedOrderRepository();
      service = new MockOrderStatusProvider();
      source = new OrderServiceFadesSource({
        postedOrders: repo,
        orderStatus: service,
        fillerEndpoints: () => [FILLER_A, FILLER_B],
        log,
        now: () => NOW,
      });
    });

    const seed = async (...records: PostedOrderRecord[]) => {
      for (const r of records) await repo.putPostedOrder(r);
      return records;
    };

    it('resolves pending orders past their deadline and leaves live ones alone', async () => {
      const [expired, filled, live] = await seed(v2(), v3(), v2({ deadline: NOW + 60 }));
      service.seed(
        status(expired.orderHash, ORDER_STATUS.EXPIRED),
        status(filled.orderHash, ORDER_STATUS.FILLED, { fillBlock: DECAY_START_BLOCK, fillTimestamp: NOW - 100 }),
        status(live.orderHash, ORDER_STATUS.OPEN)
      );

      const summary = await source.resolvePendingOutcomes(NOW);

      expect(summary).toMatchObject({ pendingPastDeadline: 2, batches: 1, resolved: 2, stillOpen: 0, notFound: 0 });
      expect(summary.byOutcome).toEqual({ [PostedOrderOutcome.EXPIRED]: 1, [PostedOrderOutcome.FILLED]: 1 });
      expect(service.batches).toEqual([[expired.orderHash, filled.orderHash]]);
      expect(await repo.getPostedOrder(expired.orderHash)).toMatchObject({
        outcome: PostedOrderOutcome.EXPIRED,
        orderStatus: 'expired',
        faded: 1,
        resolvedAt: NOW,
      });
      expect(await repo.getPostedOrder(filled.orderHash)).toMatchObject({
        outcome: PostedOrderOutcome.FILLED,
        fillBlock: DECAY_START_BLOCK,
        fillTimestamp: NOW - 100,
        faded: 0,
      });
      expect(await repo.getPostedOrder(live.orderHash)).toMatchObject({ outcome: PostedOrderOutcome.PENDING });
    });

    it('is idempotent: a second run has nothing pending and rewrites nothing', async () => {
      const [expired] = await seed(v2());
      service.seed(status(expired.orderHash, ORDER_STATUS.EXPIRED));

      await source.resolvePendingOutcomes(NOW);
      const after = await repo.getPostedOrder(expired.orderHash);
      const second = await source.resolvePendingOutcomes(NOW);

      expect(second).toMatchObject({ pendingPastDeadline: 0, batches: 0, resolved: 0 });
      expect(service.batches).toHaveLength(1);
      expect(await repo.getPostedOrder(expired.orderHash)).toEqual(after);
    });

    it('leaves still-open and not-found orders pending, and counts them', async () => {
      const [open, missing] = await seed(v2(), v2());
      service.seed(status(open.orderHash, ORDER_STATUS.OPEN));

      const summary = await source.resolvePendingOutcomes(NOW);

      expect(summary).toMatchObject({ pendingPastDeadline: 2, resolved: 0, stillOpen: 1, notFound: 1 });
      expect(await repo.getPendingPastDeadline(NOW)).toHaveLength(2);
      expect(await repo.getPostedOrder(missing.orderHash)).toMatchObject({ outcome: PostedOrderOutcome.PENDING });
    });

    it('leaves unclassifiable orders pending and counts them', async () => {
      const [fillNoTiming] = await seed(v3());
      service.seed(status(fillNoTiming.orderHash, ORDER_STATUS.FILLED));

      const summary = await source.resolvePendingOutcomes(NOW);

      expect(summary).toMatchObject({ resolved: 0, unclassifiable: 1 });
      expect(await repo.getPostedOrder(fillNoTiming.orderHash)).toMatchObject({ outcome: PostedOrderOutcome.PENDING });
    });

    it('batches at the order service cap and never exceeds it', async () => {
      const records = await seed(...Array.from({ length: ORDER_SERVICE_MAX_ORDER_HASHES * 2 + 7 }, () => v2()));
      service.seed(...records.map((r) => status(r.orderHash, ORDER_STATUS.EXPIRED)));

      const summary = await source.resolvePendingOutcomes(NOW);

      expect(service.batches.map((b) => b.length)).toEqual([
        ORDER_SERVICE_MAX_ORDER_HASHES,
        ORDER_SERVICE_MAX_ORDER_HASHES,
        7,
      ]);
      expect(summary).toMatchObject({ batches: 3, resolved: records.length });
      expect(await repo.getPendingPastDeadline(NOW)).toEqual([]);
    });

    it('caps the pending set per run and drains oldest-first', async () => {
      const records = await seed(
        ...Array.from({ length: MAX_PENDING_RESOLUTIONS_PER_RUN + 1 }, (_, i) => v2({ deadline: NOW - 100_000 + i }))
      );
      service.seed(...records.map((r) => status(r.orderHash, ORDER_STATUS.EXPIRED)));

      const summary = await source.resolvePendingOutcomes(NOW);

      expect(summary.pendingPastDeadline).toBe(MAX_PENDING_RESOLUTIONS_PER_RUN);
      const leftover = await repo.getPendingPastDeadline(NOW);
      expect(leftover.map((r) => r.orderHash)).toEqual([records[records.length - 1].orderHash]);
    });

    it('a failed batch is counted and the run continues; a write failure does not abort the batch', async () => {
      const records = await seed(...Array.from({ length: ORDER_SERVICE_MAX_ORDER_HASHES + 1 }, () => v2()));
      service.seed(...records.map((r) => status(r.orderHash, ORDER_STATUS.EXPIRED)));
      service.failures = 1;
      const failing = records[records.length - 1].orderHash;
      const realRecord = repo.recordOutcome.bind(repo);
      repo.recordOutcome = async (hash, resolution) => {
        if (hash === failing) throw new Error('dynamo write failed');
        return realRecord(hash, resolution);
      };

      const summary = await source.resolvePendingOutcomes(NOW);

      expect(summary).toMatchObject({ batches: 2, failedBatches: 1, resolved: 0, failedWrites: 1 });
      // The failed first batch stays pending for the next run.
      expect(await repo.getPendingPastDeadline(NOW)).toHaveLength(records.length);
    });

    it('stops calling the order service after consecutive failures', async () => {
      const records = await seed(
        ...Array.from({ length: ORDER_SERVICE_MAX_ORDER_HASHES * (MAX_CONSECUTIVE_BATCH_FAILURES + 2) }, () => v2())
      );
      service.failures = MAX_CONSECUTIVE_BATCH_FAILURES;

      const summary = await source.resolvePendingOutcomes(NOW);

      expect(service.batches).toHaveLength(MAX_CONSECUTIVE_BATCH_FAILURES);
      expect(summary).toMatchObject({ failedBatches: MAX_CONSECUTIVE_BATCH_FAILURES, skippedBatches: 2 });
      expect(await repo.getPendingPastDeadline(NOW)).toHaveLength(records.length);
    });

    it('stops starting batches once the time budget is spent', async () => {
      await seed(...Array.from({ length: ORDER_SERVICE_MAX_ORDER_HASHES * 3 }, () => v2()));
      source.deadlineMs = Date.now() - 1;

      const summary = await source.resolvePendingOutcomes(NOW);

      expect(service.batches).toHaveLength(0);
      expect(summary).toMatchObject({ batches: 0, skippedBatches: 3 });
    });

    it('getFades resolves first, then returns rows for the scored fillers only', async () => {
      const [aFade, aFill, bFade, unknownFiller] = await seed(
        v2({ deadline: NOW - 500 }),
        v2({ deadline: NOW - 400 }),
        v3({ filler: FILLER_B, fillerAddress: ADDR_B, deadline: NOW - 300 }),
        v2({ filler: 'https://not-configured.example', fillerAddress: ADDR_A2, deadline: NOW - 200 })
      );
      service.seed(
        status(aFade.orderHash, ORDER_STATUS.EXPIRED),
        status(aFill.orderHash, ORDER_STATUS.FILLED, { fillTimestamp: DECAY_START_TIME - 5, fillBlock: 1 }),
        status(bFade.orderHash, ORDER_STATUS.FILLED, { fillBlock: DECAY_START_BLOCK + 3, fillTimestamp: NOW - 350 }),
        status(unknownFiller.orderHash, ORDER_STATUS.EXPIRED)
      );

      const rows = await source.getFades();

      expect(rows).toEqual([
        { fillerAddress: ADDR_A, faded: 0, postTimestamp: aFill.postedAt, deadline: aFill.deadline },
        { fillerAddress: ADDR_A, faded: 1, postTimestamp: aFade.postedAt, deadline: aFade.deadline },
        { fillerAddress: ADDR_B, faded: 1, postTimestamp: bFade.postedAt, deadline: bFade.deadline },
      ]);
      expect(source.lastResolution).toMatchObject({ pendingPastDeadline: 4, resolved: 4 });
    });

    it('getFades excludes orders whose outcome is still pending after resolution', async () => {
      const [open, expired] = await seed(v2({ deadline: NOW - 500 }), v2({ deadline: NOW - 400 }));
      service.seed(status(open.orderHash, ORDER_STATUS.OPEN), status(expired.orderHash, ORDER_STATUS.EXPIRED));

      const rows = await source.getFades();

      expect(rows.map((r) => r.deadline)).toEqual([expired.deadline]);
    });
  });
});
