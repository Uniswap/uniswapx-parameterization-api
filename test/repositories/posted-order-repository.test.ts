import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { OrderType } from '@uniswap/uniswapx-sdk';

import { POSTED_ORDER_TTL_SECS } from '../../lib/constants';
import {
  DynamoPostedOrderRepository,
  PENDING_INDEX_KEY,
  PostedOrderOutcome,
  PostedOrderRecord,
  PostedOrderResolution,
} from '../../lib/repositories/posted-order-repository';
import { DYNAMO_CONFIG } from './shared';

// Same unmarshall options as the production client (postedOrderDocumentClient): numbers
// round-trip native so the deadline/decay fields compare with toEqual.
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(DYNAMO_CONFIG), {
  marshallOptions: { convertEmptyValues: true, removeUndefinedValues: true },
  unmarshallOptions: { wrapNumbers: false },
});

const repo = DynamoPostedOrderRepository.create(documentClient);

const FILLER_A = 'https://filler-a.example/rfq';
const FILLER_B = 'https://filler-b.example/rfq';
const NOW = 1_800_000_000;

const record = (overrides: Partial<PostedOrderRecord>): PostedOrderRecord => ({
  orderHash: `0x${'ab'.repeat(32)}`,
  quoteId: 'quote-1',
  requestId: 'request-1',
  chainId: 1,
  orderType: OrderType.Dutch_V2,
  fillerAddress: '0x0000000000000000000000000000000000000001',
  filler: FILLER_A,
  fillerName: 'filler-a',
  decayStartTime: NOW - 100,
  deadline: NOW - 60,
  tokenIn: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
  tokenOut: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  postedAt: NOW - 120,
  outcome: PostedOrderOutcome.PENDING,
  ...overrides,
});

describe('DynamoPostedOrderRepository', () => {
  // Deadlines relative to NOW: two of filler A's orders and one of B's are past deadline,
  // one of A's is still live. All pending.
  const pastA1 = record({ orderHash: '0x01', filler: FILLER_A, deadline: NOW - 3_600 });
  const pastA2 = record({ orderHash: '0x02', filler: FILLER_A, deadline: NOW - 60 });
  const liveA = record({ orderHash: '0x03', filler: FILLER_A, deadline: NOW + 600 });
  const pastB = record({
    orderHash: '0x04',
    filler: FILLER_B,
    fillerName: 'filler-b',
    orderType: OrderType.Dutch_V3,
    decayStartTime: undefined,
    decayStartBlock: 20_000_000,
    deadline: NOW - 30,
  });
  const exactlyNow = record({ orderHash: '0x05', filler: FILLER_B, deadline: NOW });

  beforeAll(async () => {
    for (const r of [pastA1, pastA2, liveA, pastB, exactlyNow]) {
      await repo.putPostedOrder(r);
    }
  });

  it('round-trips a V2 record by order hash, without index/TTL bookkeeping attributes', async () => {
    const stored = await repo.getPostedOrder('0x02');
    expect(stored).toEqual(pastA2);
    expect(stored).not.toHaveProperty('pending');
    expect(stored).not.toHaveProperty('ttl');
    expect(stored).not.toHaveProperty('decayStartBlock');
  });

  it('round-trips a V3 record with decayStartBlock and no decayStartTime', async () => {
    const stored = await repo.getPostedOrder('0x04');
    expect(stored).toEqual({ ...pastB, decayStartTime: undefined });
    expect(stored).not.toHaveProperty('decayStartTime');
    expect(stored?.decayStartBlock).toEqual(20_000_000);
  });

  it('returns undefined for an unknown order hash', async () => {
    await expect(repo.getPostedOrder('0xdoesnotexist')).resolves.toBeUndefined();
  });

  it('stores the sparse pending key and a TTL 48h past the deadline', async () => {
    // Read the raw item: the repository deliberately hides these attributes.
    const { Item } = await documentClient.send(
      new (
        await import('@aws-sdk/lib-dynamodb')
      ).GetCommand({
        TableName: 'PostedOrders',
        Key: { orderHash: '0x02' },
      })
    );
    expect(Item?.pending).toEqual(PENDING_INDEX_KEY);
    expect(Item?.ttl).toEqual(pastA2.deadline + POSTED_ORDER_TTL_SECS);
  });

  it('lists pending orders strictly past the deadline, oldest first', async () => {
    const rows = await repo.getPendingPastDeadline(NOW);
    expect(rows.map((r) => r.orderHash)).toEqual(['0x01', '0x02', '0x04']);
    // deadline == now is not yet "completed"; the live order is excluded too
    expect(rows.find((r) => r.orderHash === '0x05')).toBeUndefined();
    expect(rows.find((r) => r.orderHash === '0x03')).toBeUndefined();
  });

  it('honours the limit on the pending query', async () => {
    const rows = await repo.getPendingPastDeadline(NOW, 2);
    expect(rows.map((r) => r.orderHash)).toEqual(['0x01', '0x02']);
  });

  it("lists a filler's orders whose deadline falls in an inclusive window", async () => {
    const rows = await repo.getFillerOrdersByDeadline(FILLER_A, NOW - 24 * 3_600, NOW);
    expect(rows.map((r) => r.orderHash)).toEqual(['0x01', '0x02']);

    const withLive = await repo.getFillerOrdersByDeadline(FILLER_A, NOW - 24 * 3_600, NOW + 600);
    expect(withLive.map((r) => r.orderHash)).toEqual(['0x01', '0x02', '0x03']);

    const bOnly = await repo.getFillerOrdersByDeadline(FILLER_B, NOW - 24 * 3_600, NOW);
    expect(bOnly.map((r) => r.orderHash)).toEqual(['0x04', '0x05']);
  });

  it('overwrites on the same order hash (idempotent re-post)', async () => {
    await repo.putPostedOrder(record({ orderHash: '0x02', quoteId: 'quote-2' }));
    const stored = await repo.getPostedOrder('0x02');
    expect(stored?.quoteId).toEqual('quote-2');
    expect((await repo.getPendingPastDeadline(NOW)).filter((r) => r.orderHash === '0x02')).toHaveLength(1);
  });

  describe('recordOutcome', () => {
    const resolution: PostedOrderResolution = {
      outcome: PostedOrderOutcome.FILLED,
      orderStatus: 'filled',
      fillBlock: 20_000_001,
      fillTimestamp: NOW - 90,
      faded: 1,
      resolvedAt: NOW,
    };

    it('records the outcome and drops the row out of the pending index in one write', async () => {
      const pending = record({ orderHash: '0x10', deadline: NOW - 100 });
      await repo.putPostedOrder(pending);
      expect((await repo.getPendingPastDeadline(NOW)).map((r) => r.orderHash)).toContain('0x10');

      await repo.recordOutcome('0x10', resolution);

      expect(await repo.getPostedOrder('0x10')).toEqual({ ...pending, ...resolution });
      expect((await repo.getPendingPastDeadline(NOW)).map((r) => r.orderHash)).not.toContain('0x10');
      // Still reachable through the filler index for row building.
      expect((await repo.getFillerOrdersByDeadline(FILLER_A, NOW - 100, NOW - 100)).map((r) => r.orderHash)).toEqual([
        '0x10',
      ]);
    });

    it('omits fill fields that the resolution does not carry', async () => {
      await repo.putPostedOrder(record({ orderHash: '0x11', deadline: NOW - 100 }));

      await repo.recordOutcome('0x11', {
        outcome: PostedOrderOutcome.CANCELLED,
        orderStatus: 'cancelled',
        resolvedAt: NOW,
      });

      const stored = await repo.getPostedOrder('0x11');
      expect(stored).toMatchObject({
        outcome: PostedOrderOutcome.CANCELLED,
        orderStatus: 'cancelled',
        resolvedAt: NOW,
      });
      expect(stored).not.toHaveProperty('fillBlock');
      expect(stored).not.toHaveProperty('fillTimestamp');
      expect(stored).not.toHaveProperty('faded');
    });

    it('is idempotent: recording the same resolution twice leaves the row unchanged', async () => {
      await repo.putPostedOrder(record({ orderHash: '0x12', deadline: NOW - 100 }));

      await repo.recordOutcome('0x12', resolution);
      const first = await repo.getPostedOrder('0x12');
      await repo.recordOutcome('0x12', resolution);

      expect(await repo.getPostedOrder('0x12')).toEqual(first);
    });

    it('rejects for an unknown order hash instead of creating a phantom row', async () => {
      await expect(repo.recordOutcome('0xdoesnotexist', resolution)).rejects.toThrow();
      expect(await repo.getPostedOrder('0xdoesnotexist')).toBeUndefined();
    });
  });

  describe('pagination', () => {
    // A 2-item page stands in for DynamoDB's 1MB page: production hit this with a filler that
    // completes >1,600 orders in 24h, whose newest rows fell off the (deadline-ascending) first
    // page and were silently missing from the fade rows.
    const paged = DynamoPostedOrderRepository.create(documentClient, { pageSize: 2 });
    const FILLER_P = 'https://filler-paged.example/rfq';
    const rows = Array.from({ length: 7 }, (_, i) =>
      record({ orderHash: `0xp${i}`, filler: FILLER_P, fillerName: 'paged', deadline: NOW - 1_000 + i })
    );

    beforeAll(async () => {
      for (const r of rows) await paged.putPostedOrder(r);
    });

    it('getFillerOrdersByDeadline drains every page', async () => {
      const got = await paged.getFillerOrdersByDeadline(FILLER_P, NOW - 1_000, NOW - 994);
      expect(got.map((r) => r.orderHash)).toEqual(rows.map((r) => r.orderHash));
    });

    it('getPendingPastDeadline drains pages up to the requested limit, oldest first', async () => {
      const got = await paged.getPendingPastDeadline(NOW - 990, 5);
      const mine = got.filter((r) => r.filler === FILLER_P);
      expect(got.length).toBeLessThanOrEqual(5);
      // Every returned row precedes every omitted one (ascending deadline across pages).
      const omitted = rows.filter((r) => !mine.some((g) => g.orderHash === r.orderHash));
      expect(Math.max(...mine.map((r) => r.deadline))).toBeLessThan(Math.min(...omitted.map((r) => r.deadline)));
    });

    it('getPendingPastDeadline without a limit returns everything across pages', async () => {
      const got = (await paged.getPendingPastDeadline(NOW - 990)).filter((r) => r.filler === FILLER_P);
      expect(got).toHaveLength(7);
    });
  });
});
