import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { OrderType } from '@uniswap/uniswapx-sdk';

import { POSTED_ORDER_TTL_SECS } from '../../lib/constants';
import {
  DynamoPostedOrderRepository,
  PENDING_INDEX_KEY,
  PostedOrderOutcome,
  PostedOrderRecord,
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
});
