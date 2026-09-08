import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity, Table } from 'dynamodb-toolbox';

import { DYNAMO_TABLE_NAME, POSTED_ORDER_TTL_SECS, POSTED_ORDERS_INDEX } from '../constants';

/**
 * Lifecycle of a posted order as far as the fade breaker cares. Every row is written PENDING
 * by the hard-quote path; a later cron resolves it once the deadline has passed. Kept as an
 * enum so the resolved states land here rather than as stray string literals.
 */
export enum PostedOrderOutcome {
  PENDING = 'PENDING',
  // Terminal outcomes, recorded by the fade cron from the order service's orderStatus once
  // the deadline has passed (see lib/cron/order-service-fades-source.ts). FILLED and EXPIRED
  // carry a definitive `faded`; the other three are "never filled" states whose fade
  // treatment is a scoring-time policy, so the row stores the fact and not the verdict.
  FILLED = 'FILLED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  ERROR = 'ERROR',
}

/**
 * What the fade cron learned about a posted order from the order service. Written once per
 * order (idempotently) when the deadline has passed and the service reports a terminal status.
 */
export type PostedOrderResolution = {
  outcome: Exclude<PostedOrderOutcome, PostedOrderOutcome.PENDING>;
  // Raw order-service `orderStatus` the outcome was derived from, kept for audit.
  orderStatus: string;
  // Fill timing as reported by the order service (block number / unix seconds). Set for fills.
  fillBlock?: number;
  fillTimestamp?: number;
  // 1/0 for FILLED and EXPIRED, where the breaker's rule is definitive; undefined for the
  // never-filled non-expiry outcomes, which the row builder scores by policy flag.
  faded?: number;
  // Unix seconds at which the cron recorded the outcome.
  resolvedAt: number;
};

/**
 * One row per confirmed RFQ-won order post. Everything the breaker needs about the "posted"
 * half of a fade, captured first-hand at post time instead of reconstructed from x-service
 * logs in Redshift.
 */
export type PostedOrderRecord = {
  // Cosigned order hash — the same value the order service keys on. Partition key.
  orderHash: string;
  // quoteId sent to the order service (the winning RFQ quote's id). Join key to Redshift.
  quoteId: string;
  requestId: string;
  chainId: number;
  // OrderType.Dutch_V2 | OrderType.Dutch_V3, spelled the way Redshift's `ordertype` is.
  orderType: string;
  // Exclusive filler from the cosigner data, checksummed. Never the zero address: open
  // orders and non-improving quotes are not recorded.
  fillerAddress: string;
  // The identity the breaker scores by: the RFQ webhook endpoint the winning quote came
  // from (same key space as FillerAddress.filler and FillerCBTimestampsV2.hash).
  filler: string;
  // Human-readable RFQ config name, for dashboards; not a key.
  fillerName: string;
  // Exactly one of these is set, by orderType: V2 decays by wallclock, V3 by block.
  decayStartTime?: number;
  decayStartBlock?: number;
  // Order deadline (unix seconds). "Completed" for the breaker means deadline < now, so
  // this is the sort key of both indexes.
  deadline: number;
  tokenIn: string;
  tokenOut: string;
  // Unix seconds at which the post was confirmed.
  postedAt: number;
  outcome: PostedOrderOutcome;
  // Present once the outcome is no longer PENDING (see PostedOrderResolution).
  orderStatus?: string;
  fillBlock?: number;
  fillTimestamp?: number;
  faded?: number;
  resolvedAt?: number;
};

export interface PostedOrderRepository {
  putPostedOrder(record: PostedOrderRecord): Promise<void>;
  getPostedOrder(orderHash: string): Promise<PostedOrderRecord | undefined>;
  /** Orders whose deadline is strictly before `now` and whose outcome is still PENDING. */
  getPendingPastDeadline(now: number, limit?: number): Promise<PostedOrderRecord[]>;
  /** A filler's orders whose deadline falls in [from, to], inclusive, oldest first. */
  getFillerOrdersByDeadline(filler: string, from: number, to: number): Promise<PostedOrderRecord[]>;
  /**
   * Records a terminal outcome and drops the row out of the pending index in the same write.
   * Idempotent: re-recording the same resolution is a harmless overwrite. Rejects (rather than
   * creating a phantom row) when the order is unknown, e.g. already expired by TTL.
   */
  recordOutcome(orderHash: string, resolution: PostedOrderResolution): Promise<void>;
}

// Constant partition key of the sparse pending index. Present only while outcome is
// PENDING; the outcome-recording write (later PR) must remove it in the same UpdateItem so
// the row leaves the index. One partition is fine at hard-quote volume (DynamoDB allows
// 1,000 WCU/s per partition key); shard the value by deadline hour if that is ever reached.
export const PENDING_INDEX_KEY = 'PENDING';

// The write sits in series with the hard-quote response, so the client itself is bounded:
// one attempt, short connect/request ceilings. The recorder adds an outer wall on top.
export const POSTED_ORDER_CONNECTION_TIMEOUT_MS = 200;
export const POSTED_ORDER_REQUEST_TIMEOUT_MS = 300;
export const POSTED_ORDER_MAX_ATTEMPTS = 1;

/**
 * Bounded document client for the posted-orders write path. Numbers are read back native
 * (wrapNumbers:false) because the sort keys are unix seconds / block numbers, and undefined
 * optional attributes (the unused decay-start field) are dropped rather than rejected.
 * `maxAttempts` is the SDK's own retry budget; the sibling FillerAddress write allows one retry
 * under the same per-request ceilings.
 */
export function postedOrderDocumentClient(maxAttempts: number = POSTED_ORDER_MAX_ATTEMPTS): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({
      requestHandler: {
        connectionTimeout: POSTED_ORDER_CONNECTION_TIMEOUT_MS,
        requestTimeout: POSTED_ORDER_REQUEST_TIMEOUT_MS,
      },
      maxAttempts,
    }),
    {
      marshallOptions: { convertEmptyValues: true, removeUndefinedValues: true },
      unmarshallOptions: { wrapNumbers: false },
    }
  );
}

// Raw item shape as dynamodb-toolbox returns it (record fields plus the index/TTL
// attributes it manages).
type PostedOrderItem = PostedOrderRecord & {
  pending?: string;
  ttl: number;
};

export class DynamoPostedOrderRepository implements PostedOrderRepository {
  static PARTITION_KEY = 'orderHash';

  static create(documentClient: DynamoDBDocumentClient = postedOrderDocumentClient()): PostedOrderRepository {
    const table = new Table({
      name: DYNAMO_TABLE_NAME.POSTED_ORDERS,
      partitionKey: DynamoPostedOrderRepository.PARTITION_KEY,
      indexes: {
        [POSTED_ORDERS_INDEX.PENDING_DEADLINE]: { partitionKey: 'pending', sortKey: 'deadline' },
        [POSTED_ORDERS_INDEX.FILLER_DEADLINE]: { partitionKey: 'filler', sortKey: 'deadline' },
      },
      DocumentClient: documentClient,
    });

    const entity = new Entity({
      name: 'PostedOrder',
      attributes: {
        orderHash: { partitionKey: true, type: 'string' },
        quoteId: { type: 'string', required: true },
        requestId: { type: 'string', required: true },
        chainId: { type: 'number', required: true },
        orderType: { type: 'string', required: true },
        fillerAddress: { type: 'string', required: true },
        filler: { type: 'string', required: true },
        fillerName: { type: 'string', required: true },
        decayStartTime: { type: 'number' },
        decayStartBlock: { type: 'number' },
        deadline: { type: 'number', required: true },
        tokenIn: { type: 'string', required: true },
        tokenOut: { type: 'string', required: true },
        postedAt: { type: 'number', required: true },
        outcome: { type: 'string', required: true },
        orderStatus: { type: 'string' },
        fillBlock: { type: 'number' },
        fillTimestamp: { type: 'number' },
        faded: { type: 'number' },
        resolvedAt: { type: 'number' },
        pending: { type: 'string' },
        ttl: { type: 'number', required: true },
      },
      table,
      autoExecute: true,
    } as const);

    return new DynamoPostedOrderRepository(entity);
  }

  private constructor(private readonly entity: Entity) {}

  public async putPostedOrder(record: PostedOrderRecord): Promise<void> {
    const item: PostedOrderItem = {
      ...record,
      ttl: record.deadline + POSTED_ORDER_TTL_SECS,
      ...(record.outcome === PostedOrderOutcome.PENDING && { pending: PENDING_INDEX_KEY }),
    };
    await this.entity.put(item, { execute: true });
  }

  public async getPostedOrder(orderHash: string): Promise<PostedOrderRecord | undefined> {
    const { Item } = await this.entity.get({ orderHash }, { execute: true, parse: true });
    return Item ? toRecord(Item as PostedOrderItem) : undefined;
  }

  public async getPendingPastDeadline(now: number, limit?: number): Promise<PostedOrderRecord[]> {
    const { Items } = await this.entity.query(PENDING_INDEX_KEY, {
      index: POSTED_ORDERS_INDEX.PENDING_DEADLINE,
      lt: now,
      ...(limit !== undefined && { limit }),
      execute: true,
      parse: true,
    });
    return ((Items ?? []) as PostedOrderItem[]).map(toRecord);
  }

  public async getFillerOrdersByDeadline(filler: string, from: number, to: number): Promise<PostedOrderRecord[]> {
    const { Items } = await this.entity.query(filler, {
      index: POSTED_ORDERS_INDEX.FILLER_DEADLINE,
      between: [from, to],
      execute: true,
      parse: true,
    });
    return ((Items ?? []) as PostedOrderItem[]).map(toRecord);
  }

  public async recordOutcome(orderHash: string, resolution: PostedOrderResolution): Promise<void> {
    const { outcome, orderStatus, fillBlock, fillTimestamp, faded, resolvedAt } = resolution;
    await this.entity.update(
      {
        orderHash,
        outcome,
        orderStatus,
        resolvedAt,
        ...(fillBlock !== undefined && { fillBlock }),
        ...(fillTimestamp !== undefined && { fillTimestamp }),
        ...(faded !== undefined && { faded }),
        // Leaving the sparse pending index is what makes the outcome "recorded" for the
        // cron's next getPendingPastDeadline; it must happen in this same UpdateItem.
        $remove: ['pending'],
      },
      {
        conditions: { attr: DynamoPostedOrderRepository.PARTITION_KEY, exists: true },
        execute: true,
      }
    );
  }
}

// Picks the record fields out of a stored item, dropping the index/TTL attributes and the
// toolbox bookkeeping (entity, created, modified) so callers see exactly PostedOrderRecord.
function toRecord(item: PostedOrderItem): PostedOrderRecord {
  return {
    orderHash: item.orderHash,
    quoteId: item.quoteId,
    requestId: item.requestId,
    chainId: item.chainId,
    orderType: item.orderType,
    fillerAddress: item.fillerAddress,
    filler: item.filler,
    fillerName: item.fillerName,
    ...(item.decayStartTime !== undefined && { decayStartTime: item.decayStartTime }),
    ...(item.decayStartBlock !== undefined && { decayStartBlock: item.decayStartBlock }),
    deadline: item.deadline,
    tokenIn: item.tokenIn,
    tokenOut: item.tokenOut,
    postedAt: item.postedAt,
    outcome: item.outcome,
    ...(item.orderStatus !== undefined && { orderStatus: item.orderStatus }),
    ...(item.fillBlock !== undefined && { fillBlock: item.fillBlock }),
    ...(item.fillTimestamp !== undefined && { fillTimestamp: item.fillTimestamp }),
    ...(item.faded !== undefined && { faded: item.faded }),
    ...(item.resolvedAt !== undefined && { resolvedAt: item.resolvedAt }),
  };
}

/** In-memory fake with the same access patterns, for handler and recorder tests. */
export class MockPostedOrderRepository implements PostedOrderRepository {
  public readonly records = new Map<string, PostedOrderRecord>();

  async putPostedOrder(record: PostedOrderRecord): Promise<void> {
    this.records.set(record.orderHash, { ...record });
  }

  async getPostedOrder(orderHash: string): Promise<PostedOrderRecord | undefined> {
    return this.records.get(orderHash);
  }

  async getPendingPastDeadline(now: number, limit?: number): Promise<PostedOrderRecord[]> {
    const rows = [...this.records.values()]
      .filter((r) => r.outcome === PostedOrderOutcome.PENDING && r.deadline < now)
      .sort((a, b) => a.deadline - b.deadline);
    return limit === undefined ? rows : rows.slice(0, limit);
  }

  async getFillerOrdersByDeadline(filler: string, from: number, to: number): Promise<PostedOrderRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.filler === filler && r.deadline >= from && r.deadline <= to)
      .sort((a, b) => a.deadline - b.deadline);
  }

  async recordOutcome(orderHash: string, resolution: PostedOrderResolution): Promise<void> {
    const existing = this.records.get(orderHash);
    if (!existing) {
      throw new Error(`The conditional request failed: no posted order ${orderHash}`);
    }
    const { outcome, orderStatus, fillBlock, fillTimestamp, faded, resolvedAt } = resolution;
    this.records.set(orderHash, {
      ...existing,
      outcome,
      orderStatus,
      resolvedAt,
      ...(fillBlock !== undefined && { fillBlock }),
      ...(fillTimestamp !== undefined && { fillTimestamp }),
      ...(faded !== undefined && { faded }),
    });
  }
}
