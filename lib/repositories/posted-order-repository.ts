import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  QueryCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

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
  // The cron gave up: the order service never reported a usable terminal status within
  // MAX_RESOLUTION_ATTEMPTS. Terminal for the breaker (no row, no re-fetch) so one class of
  // unresolvable orders cannot occupy the oldest-first pending read and starve newer ones.
  UNRESOLVED = 'UNRESOLVED',
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
 * logs in the analytics warehouse.
 */
export type PostedOrderRecord = {
  // Cosigned order hash — the same value the order service keys on. Partition key.
  orderHash: string;
  // quoteId sent to the order service (the winning RFQ quote's id). Join key to the analytics tables.
  quoteId: string;
  requestId: string;
  chainId: number;
  // OrderType.Dutch_V2 | OrderType.Dutch_V3, spelled the way the analytics `ordertype` column is.
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
  // Cron runs that asked the order service about this order without getting a usable terminal
  // status (still open, unknown hash, unclassifiable). Drives the give-up in the fades source.
  resolutionAttempts?: number;
  lastAttemptAt?: number;
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
  /**
   * Counts one more run in which the order could not be resolved and returns the new count.
   * The row stays pending. Rejects when the order is unknown (e.g. already expired by TTL).
   */
  recordUnresolvedAttempt(orderHash: string, attemptedAt: number): Promise<number>;
}

// Constant partition key of the sparse pending index. Present only while outcome is
// PENDING; recordOutcome removes it in the same UpdateItem so the row leaves the index. One partition is fine at hard-quote volume (DynamoDB allows
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

// Stored item: the record fields plus the index/TTL attributes the repository manages. Rows
// written before this repository dropped dynamodb-toolbox also carry its _et/_ct/_md
// bookkeeping attributes; nothing reads them.
type PostedOrderItem = PostedOrderRecord & {
  pending?: string;
  ttl: number;
};

// Key condition of an index query, on that index's sort key (deadline).
type DeadlineCondition = { lt: number } | { between: [number, number] };

export type DynamoPostedOrderRepositoryOptions = {
  // Items requested per DynamoDB page. Production leaves this unset (DynamoDB's 1MB page);
  // tests set it small to exercise pagination without writing a megabyte of rows.
  pageSize?: number;
};

export class DynamoPostedOrderRepository implements PostedOrderRepository {
  static PARTITION_KEY = 'orderHash';

  static create(
    documentClient: DynamoDBDocumentClient = postedOrderDocumentClient(),
    options: DynamoPostedOrderRepositoryOptions = {}
  ): PostedOrderRepository {
    return new DynamoPostedOrderRepository(documentClient, options.pageSize);
  }

  private constructor(private readonly documentClient: DynamoDBDocumentClient, private readonly pageSize?: number) {}

  /**
   * Drains every page of an index query, deadline ascending. A single DynamoDB page is at most
   * 1MB (~1,600 of these rows), and a high-volume filler completes more than that in 24h — an
   * unpaginated read would silently drop its most recent orders, exactly the ones the breaker
   * scores. `max` caps the total; DynamoDB's Limit alone cannot, because a Limit page can still
   * be cut short by the size cap.
   */
  private async queryAll(
    index: string,
    partitionKeyName: string,
    partitionKey: string,
    deadline: DeadlineCondition,
    max?: number
  ): Promise<PostedOrderItem[]> {
    const pageLimit = this.pageSize ?? max;
    const input: QueryCommandInput = {
      TableName: DYNAMO_TABLE_NAME.POSTED_ORDERS,
      IndexName: index,
      KeyConditionExpression:
        'lt' in deadline ? '#pk = :pk AND #deadline < :lt' : '#pk = :pk AND #deadline BETWEEN :from AND :to',
      ExpressionAttributeNames: { '#pk': partitionKeyName, '#deadline': 'deadline' },
      ExpressionAttributeValues:
        'lt' in deadline
          ? { ':pk': partitionKey, ':lt': deadline.lt }
          : { ':pk': partitionKey, ':from': deadline.between[0], ':to': deadline.between[1] },
      ...(pageLimit !== undefined && { Limit: pageLimit }),
    };
    const items: PostedOrderItem[] = [];
    for (let startKey: Record<string, unknown> | undefined; ; ) {
      const page = await this.documentClient.send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }));
      items.push(...((page.Items ?? []) as PostedOrderItem[]));
      if (max !== undefined && items.length >= max) return items.slice(0, max);
      if (!page.LastEvaluatedKey) return items;
      startKey = page.LastEvaluatedKey;
    }
  }

  public async putPostedOrder(record: PostedOrderRecord): Promise<void> {
    const item: PostedOrderItem = {
      ...record,
      ttl: record.deadline + POSTED_ORDER_TTL_SECS,
      ...(record.outcome === PostedOrderOutcome.PENDING && { pending: PENDING_INDEX_KEY }),
    };
    await this.documentClient.send(
      new PutCommand({ TableName: DYNAMO_TABLE_NAME.POSTED_ORDERS, Item: withoutUndefined(item) })
    );
  }

  public async getPostedOrder(orderHash: string): Promise<PostedOrderRecord | undefined> {
    const { Item } = await this.documentClient.send(
      new GetCommand({
        TableName: DYNAMO_TABLE_NAME.POSTED_ORDERS,
        Key: { [DynamoPostedOrderRepository.PARTITION_KEY]: orderHash },
      })
    );
    return Item ? toRecord(Item as PostedOrderItem) : undefined;
  }

  public async getPendingPastDeadline(now: number, limit?: number): Promise<PostedOrderRecord[]> {
    const items = await this.queryAll(
      POSTED_ORDERS_INDEX.PENDING_DEADLINE,
      'pending',
      PENDING_INDEX_KEY,
      { lt: now },
      limit
    );
    return items.map(toRecord);
  }

  public async getFillerOrdersByDeadline(filler: string, from: number, to: number): Promise<PostedOrderRecord[]> {
    const items = await this.queryAll(POSTED_ORDERS_INDEX.FILLER_DEADLINE, 'filler', filler, {
      between: [from, to],
    });
    return items.map(toRecord);
  }

  public async recordOutcome(orderHash: string, resolution: PostedOrderResolution): Promise<void> {
    const { outcome, orderStatus, fillBlock, fillTimestamp, faded, resolvedAt } = resolution;
    const set = withoutUndefined({ outcome, orderStatus, resolvedAt, fillBlock, fillTimestamp, faded });
    const fields = Object.keys(set);
    await this.documentClient.send(
      new UpdateCommand({
        TableName: DYNAMO_TABLE_NAME.POSTED_ORDERS,
        Key: { [DynamoPostedOrderRepository.PARTITION_KEY]: orderHash },
        // Leaving the sparse pending index is what makes the outcome "recorded" for the
        // cron's next getPendingPastDeadline; it must happen in this same UpdateItem.
        UpdateExpression: `SET ${fields.map((f) => `#${f} = :${f}`).join(', ')} REMOVE #pending`,
        ConditionExpression: 'attribute_exists(#orderHash)',
        ExpressionAttributeNames: {
          ...Object.fromEntries(fields.map((f) => [`#${f}`, f])),
          '#pending': 'pending',
          '#orderHash': DynamoPostedOrderRepository.PARTITION_KEY,
        },
        ExpressionAttributeValues: Object.fromEntries(Object.entries(set).map(([f, v]) => [`:${f}`, v])),
      })
    );
  }

  public async recordUnresolvedAttempt(orderHash: string, attemptedAt: number): Promise<number> {
    const { Attributes } = await this.documentClient.send(
      new UpdateCommand({
        TableName: DYNAMO_TABLE_NAME.POSTED_ORDERS,
        Key: { [DynamoPostedOrderRepository.PARTITION_KEY]: orderHash },
        UpdateExpression: 'SET #lastAttemptAt = :lastAttemptAt ADD #resolutionAttempts :one',
        ConditionExpression: 'attribute_exists(#orderHash)',
        ExpressionAttributeNames: {
          '#lastAttemptAt': 'lastAttemptAt',
          '#resolutionAttempts': 'resolutionAttempts',
          '#orderHash': DynamoPostedOrderRepository.PARTITION_KEY,
        },
        ExpressionAttributeValues: { ':lastAttemptAt': attemptedAt, ':one': 1 },
        ReturnValues: 'UPDATED_NEW',
      })
    );
    return Number((Attributes as { resolutionAttempts?: number } | undefined)?.resolutionAttempts ?? 0);
  }
}

// Drops undefined attributes so writes do not depend on the client's removeUndefinedValues.
function withoutUndefined<T extends object>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// Picks the record fields out of a stored item, dropping the index/TTL attributes (and, on
// older rows, the toolbox bookkeeping) so callers see exactly PostedOrderRecord.
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
    ...(item.resolutionAttempts !== undefined && { resolutionAttempts: item.resolutionAttempts }),
    ...(item.lastAttemptAt !== undefined && { lastAttemptAt: item.lastAttemptAt }),
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

  async recordUnresolvedAttempt(orderHash: string, attemptedAt: number): Promise<number> {
    const existing = this.records.get(orderHash);
    if (!existing) {
      throw new Error(`The conditional request failed: no posted order ${orderHash}`);
    }
    const resolutionAttempts = (existing.resolutionAttempts ?? 0) + 1;
    this.records.set(orderHash, { ...existing, resolutionAttempts, lastAttemptAt: attemptedAt });
    return resolutionAttempts;
  }
}
