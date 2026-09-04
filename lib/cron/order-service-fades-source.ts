import { OrderType, PERMISSIONED_TOKENS } from '@uniswap/uniswapx-sdk';
import Logger from 'bunyan';
import { ethers } from 'ethers';

import { OrderServiceOrderStatus, OrderStatusProvider } from '../providers/order';
import { ORDER_SERVICE_MAX_ORDER_HASHES } from '../providers/order/uniswapxService';
import { ORDERS_PER_FILLER_LIMIT, V2FadesRowType } from '../repositories/fades-repository';
import {
  PostedOrderOutcome,
  PostedOrderRecord,
  PostedOrderRepository,
  PostedOrderResolution,
} from '../repositories/posted-order-repository';

/**
 * What the fade cron consumes: per-order rows in the shape of V2_FADE_RATE_SQL's result.
 * V2FadesRepository (Redshift) satisfies this structurally; OrderServiceFadesSource is the
 * GPA-owned implementation. Everything downstream (getFillersFadeStats, calculateNewTimestamps)
 * is shared, so the two sources can only differ in the rows they produce.
 */
export interface FadesSource {
  getFades(): Promise<V2FadesRowType[]>;
}

// Rolling window on order completion time, mirroring the view's
// `deadline >= GETDATE() - INTERVAL '24 HOURS'`.
export const FADE_WINDOW_SECS = 24 * 60 * 60;
// Testnets the view drops: goerli, polygon goerli, optimism goerli, arbitrum goerli. Kept as
// the same literal list as V2_CREATE_VIEW_SQL so the two sources cannot drift apart.
export const EXCLUDED_TESTNET_CHAIN_IDS: readonly number[] = [5, 8001, 420, 421613];
// Pending orders resolved per cron run. At ORDER_SERVICE_MAX_ORDER_HASHES per request this is
// 20 requests; anything beyond it waits for the next run (the pending index is oldest-first,
// so a backlog drains in deadline order).
export const MAX_PENDING_RESOLUTIONS_PER_RUN = 1000;
// Consecutive failed status batches after which the run stops calling the order service: the
// remaining batches would only burn the time budget against a service that is down.
export const MAX_CONSECUTIVE_BATCH_FAILURES = 3;

/** Order-service `orderStatus` values the classifier understands. */
export const ORDER_STATUS = {
  OPEN: 'open',
  FILLED: 'filled',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  INSUFFICIENT_FUNDS: 'insufficient-funds',
  ERROR: 'error',
} as const;

// Lowercased permissioned-token addresses, compared chain-agnostically exactly as the SQL's
// `LOWER(tokenIn) NOT IN (...)` does.
const PERMISSIONED_TOKEN_ADDRESSES = new Set(PERMISSIONED_TOKENS.map((token) => token.address.toLowerCase()));

export function isPermissionedToken(address: string): boolean {
  return PERMISSIONED_TOKEN_ADDRESSES.has(address.toLowerCase());
}

export type Classification =
  // Terminal status with a recordable outcome.
  | { kind: 'resolved'; resolution: PostedOrderResolution }
  // The order service still says `open` even though the deadline has passed: its status
  // poller has not caught up yet. Leave the row pending and ask again next run.
  | { kind: 'still-open' }
  // A status we cannot score (unknown status string, a fill without timing, an unknown order
  // type). Left pending so it is visible as a count; it expires with the row's TTL.
  | { kind: 'unclassifiable'; reason: string };

/**
 * Maps an order-service status onto the breaker's fade rule for one posted order. Mirrors the
 * `faded` CASE in V2_FADE_RATE_SQL:
 *
 *   status              | Dutch_V2                                | Dutch_V3
 *   --------------------|-----------------------------------------|----------------------------------
 *   filled              | faded iff fillTimestamp > decayStartTime| faded iff fillBlock > decayStartBlock
 *   expired             | faded                                   | faded
 *   cancelled / insufficient-funds / error | recorded, no verdict (scored by policy flag; the SQL's
 *                       |   `fillTimestamp IS NULL` branch counts these as fades today)
 *   open                | not terminal: stays pending             | stays pending
 *
 * A fill AT the decay-start block/time is not a fade: the exclusive filler still paid the
 * undecayed price (the SQL's `fillTimeBlocks > 0` / `decayStartTime < fillTimestamp`).
 */
export function classifyOutcome(
  record: PostedOrderRecord,
  status: OrderServiceOrderStatus,
  resolvedAt: number
): Classification {
  const base = { orderStatus: status.orderStatus, resolvedAt };
  switch (status.orderStatus) {
    case ORDER_STATUS.OPEN:
      return { kind: 'still-open' };
    case ORDER_STATUS.EXPIRED:
      return { kind: 'resolved', resolution: { ...base, outcome: PostedOrderOutcome.EXPIRED, faded: 1 } };
    case ORDER_STATUS.CANCELLED:
      return { kind: 'resolved', resolution: { ...base, outcome: PostedOrderOutcome.CANCELLED } };
    case ORDER_STATUS.INSUFFICIENT_FUNDS:
      return { kind: 'resolved', resolution: { ...base, outcome: PostedOrderOutcome.INSUFFICIENT_FUNDS } };
    case ORDER_STATUS.ERROR:
      return { kind: 'resolved', resolution: { ...base, outcome: PostedOrderOutcome.ERROR } };
    case ORDER_STATUS.FILLED: {
      const timing = { fillBlock: status.fillBlock, fillTimestamp: status.fillTimestamp };
      if (record.orderType === OrderType.Dutch_V3) {
        if (status.fillBlock === undefined || record.decayStartBlock === undefined) {
          return { kind: 'unclassifiable', reason: 'Dutch_V3 fill without fillBlock/decayStartBlock' };
        }
        const faded = status.fillBlock > record.decayStartBlock ? 1 : 0;
        return { kind: 'resolved', resolution: { ...base, ...timing, outcome: PostedOrderOutcome.FILLED, faded } };
      }
      if (record.orderType === OrderType.Dutch_V2) {
        if (status.fillTimestamp === undefined || record.decayStartTime === undefined) {
          return { kind: 'unclassifiable', reason: 'Dutch_V2 fill without fillTimestamp/decayStartTime' };
        }
        const faded = status.fillTimestamp > record.decayStartTime ? 1 : 0;
        return { kind: 'resolved', resolution: { ...base, ...timing, outcome: PostedOrderOutcome.FILLED, faded } };
      }
      return { kind: 'unclassifiable', reason: `unknown order type ${record.orderType}` };
    }
    default:
      return { kind: 'unclassifiable', reason: `unknown order status ${status.orderStatus}` };
  }
}

export type FadeRowPolicy = {
  // PARITY FLAG. The SQL scores every never-filled order as a fade (`fillTimestamp IS NULL`),
  // which includes cancelled, insufficient-funds and error orders alongside expiries. `true`
  // reproduces that; `false` drops those orders from the rows entirely (neither fade nor
  // clean fill), which is the candidate behavior change to decide on after the shadow.
  countNeverFilledTerminalAsFade: boolean;
};

export const DEFAULT_FADE_ROW_POLICY: FadeRowPolicy = { countNeverFilledTerminalAsFade: true };

/**
 * The 0/1 the row builder scores an order as, or undefined when the order contributes no row
 * (still pending, or a never-filled non-expiry under the policy that excludes them).
 */
export function fadedForScoring(record: PostedOrderRecord, policy: FadeRowPolicy): number | undefined {
  switch (record.outcome) {
    case PostedOrderOutcome.PENDING:
      return undefined;
    case PostedOrderOutcome.FILLED:
    case PostedOrderOutcome.EXPIRED:
      return record.faded;
    case PostedOrderOutcome.CANCELLED:
    case PostedOrderOutcome.INSUFFICIENT_FUNDS:
    case PostedOrderOutcome.ERROR:
      return policy.countNeverFilledTerminalAsFade ? 1 : undefined;
    default:
      return undefined;
  }
}

/**
 * Rebuilds V2_FADE_RATE_SQL's rows from PostedOrders records, in the SQL's order of operations:
 *
 *  1. completed orders only (deadline < now) — in-flight orders never consume window slots;
 *  2. the ORDERS_PER_FILLER_LIMIT most recently posted orders per filler ADDRESS (the view
 *     partitions by the exclusive filler address, before any other filter — so a permissioned
 *     token order or a not-yet-resolved order still occupies a slot);
 *  3. then the 24h completion window, testnets, the zero filler, missing quoteId, the
 *     permissioned-token lists (both legs), and orders with no recorded outcome (the SQL's
 *     LEFT JOIN drops rows that have not landed in archivedorders yet).
 *
 * Output rows are exactly V2FadesRowType, ordered by filler address then deadline desc like
 * the SQL. `postTimestamp` is GPA's post-confirmation time; the SQL's `createdat` is the order
 * service's, which can trail or lead by a second or two — callers match rows on
 * (fillerAddress, deadline), not on postTimestamp.
 */
export function buildFadeRows(
  records: PostedOrderRecord[],
  args: { now: number; policy?: FadeRowPolicy }
): V2FadesRowType[] {
  const { now } = args;
  const policy = args.policy ?? DEFAULT_FADE_ROW_POLICY;
  const windowStart = now - FADE_WINDOW_SECS;

  const byAddress = new Map<string, PostedOrderRecord[]>();
  records
    .filter((record) => record.deadline < now)
    .forEach((record) => {
      const key = record.fillerAddress.toLowerCase();
      byAddress.set(key, [...(byAddress.get(key) ?? []), record]);
    });

  const rows: V2FadesRowType[] = [];
  byAddress.forEach((orders) => {
    orders
      .sort(byMostRecentlyPosted)
      .slice(0, ORDERS_PER_FILLER_LIMIT)
      .forEach((record) => {
        if (record.deadline < windowStart) return;
        if (EXCLUDED_TESTNET_CHAIN_IDS.includes(record.chainId)) return;
        if (record.fillerAddress === ethers.constants.AddressZero) return;
        if (!record.quoteId) return;
        if (isPermissionedToken(record.tokenIn) || isPermissionedToken(record.tokenOut)) return;
        const faded = fadedForScoring(record, policy);
        if (faded === undefined) return;
        rows.push({
          fillerAddress: record.fillerAddress,
          faded,
          postTimestamp: record.postedAt,
          deadline: record.deadline,
        });
      });
  });

  return rows.sort(
    (a, b) => a.fillerAddress.toLowerCase().localeCompare(b.fillerAddress.toLowerCase()) || b.deadline - a.deadline
  );
}

// createdat DESC in the view; ties broken deterministically so a re-run yields the same slots.
function byMostRecentlyPosted(a: PostedOrderRecord, b: PostedOrderRecord): number {
  return b.postedAt - a.postedAt || b.deadline - a.deadline || a.orderHash.localeCompare(b.orderHash);
}

export type ResolutionSummary = {
  // Pending orders past their deadline at the start of the run (capped at
  // MAX_PENDING_RESOLUTIONS_PER_RUN, so a value at the cap means a backlog).
  pendingPastDeadline: number;
  batches: number;
  failedBatches: number;
  // Batches never sent because the time budget ran out or the service kept failing.
  skippedBatches: number;
  resolved: number;
  // Past the deadline but the service still reports `open`: poller lag. Left pending.
  stillOpen: number;
  // The service returned nothing for the hash. Left pending; a persistent count here means
  // GPA and the order service disagree about what was posted.
  notFound: number;
  unclassifiable: number;
  failedWrites: number;
  byOutcome: Partial<Record<PostedOrderOutcome, number>>;
};

export interface OrderServiceFadesSourceDeps {
  postedOrders: PostedOrderRepository;
  orderStatus: OrderStatusProvider;
  // Filler identities (webhook endpoints) to load rows for: the same list the cron scores.
  fillerEndpoints: () => string[];
  log: Logger;
  now?: () => number;
  policy?: FadeRowPolicy;
}

/**
 * Fade rows from GPA-owned data. Each getFades() first resolves pending orders past their
 * deadline against the order service (persisting outcomes so every order is fetched once),
 * then rebuilds the SQL's per-filler rows from the 24h window of resolved orders.
 */
export class OrderServiceFadesSource implements FadesSource {
  public lastResolution?: ResolutionSummary;
  // Wallclock (ms) after which no further order-service batches are started; set by the
  // caller before each getFades(). Resolution is best-effort per run: what is not resolved
  // now is resolved next run.
  public deadlineMs?: number;
  private readonly now: () => number;
  private readonly policy: FadeRowPolicy;

  constructor(private readonly deps: OrderServiceFadesSourceDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.policy = deps.policy ?? DEFAULT_FADE_ROW_POLICY;
  }

  async getFades(): Promise<V2FadesRowType[]> {
    const now = this.now();
    this.lastResolution = await this.resolvePendingOutcomes(now);
    const records = await this.loadCompletedWindow(now);
    const rows = buildFadeRows(records, { now, policy: this.policy });
    this.deps.log.info(
      { records: records.length, rows: rows.length, resolution: this.lastResolution },
      'order-service fade rows'
    );
    return rows;
  }

  /** Every order for the scored fillers whose deadline fell in [now - 24h, now). */
  async loadCompletedWindow(now: number): Promise<PostedOrderRecord[]> {
    const endpoints = [...new Set(this.deps.fillerEndpoints())];
    const perFiller = await Promise.all(
      endpoints.map((filler) =>
        this.deps.postedOrders.getFillerOrdersByDeadline(filler, now - FADE_WINDOW_SECS, now - 1)
      )
    );
    // Rows are keyed by orderHash, so the union is already distinct per filler; dedupe anyway
    // in case two endpoint strings ever alias the same filler.
    const byHash = new Map<string, PostedOrderRecord>();
    perFiller.flat().forEach((record) => byHash.set(record.orderHash, record));
    return [...byHash.values()];
  }

  /**
   * Resolves pending orders past their deadline: batches of ORDER_SERVICE_MAX_ORDER_HASHES to
   * the order service, one idempotent outcome write per terminal order. Stops early on the
   * time budget or repeated service failures; leftovers are picked up next run.
   */
  async resolvePendingOutcomes(now: number): Promise<ResolutionSummary> {
    const { postedOrders, orderStatus, log } = this.deps;
    const summary: ResolutionSummary = {
      pendingPastDeadline: 0,
      batches: 0,
      failedBatches: 0,
      skippedBatches: 0,
      resolved: 0,
      stillOpen: 0,
      notFound: 0,
      unclassifiable: 0,
      failedWrites: 0,
      byOutcome: {},
    };

    const pending = await postedOrders.getPendingPastDeadline(now, MAX_PENDING_RESOLUTIONS_PER_RUN);
    summary.pendingPastDeadline = pending.length;

    const batches = chunk(pending, ORDER_SERVICE_MAX_ORDER_HASHES);
    let consecutiveFailures = 0;
    for (let i = 0; i < batches.length; i++) {
      if (this.deadlineMs !== undefined && Date.now() >= this.deadlineMs) {
        summary.skippedBatches = batches.length - i;
        log.warn({ skippedBatches: summary.skippedBatches }, 'order-service resolution stopped: time budget exhausted');
        break;
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
        summary.skippedBatches = batches.length - i;
        log.warn({ skippedBatches: summary.skippedBatches }, 'order-service resolution stopped: service failing');
        break;
      }

      const batch = batches[i];
      summary.batches += 1;
      let statuses: OrderServiceOrderStatus[];
      try {
        statuses = await orderStatus.getOrdersByHashes(batch.map((record) => record.orderHash));
        consecutiveFailures = 0;
      } catch (e) {
        summary.failedBatches += 1;
        consecutiveFailures += 1;
        log.warn(
          { error: e instanceof Error ? e.message : e, batch: batch.length },
          'order-service status batch failed'
        );
        continue;
      }
      const byHash = new Map(statuses.map((status) => [status.orderHash.toLowerCase(), status]));

      const writes = batch.map(async (record) => {
        const status = byHash.get(record.orderHash.toLowerCase());
        if (!status) {
          summary.notFound += 1;
          return;
        }
        const classification = classifyOutcome(record, status, now);
        switch (classification.kind) {
          case 'still-open':
            summary.stillOpen += 1;
            return;
          case 'unclassifiable':
            summary.unclassifiable += 1;
            log.warn(
              { orderHash: record.orderHash, status, reason: classification.reason },
              'unclassifiable order outcome'
            );
            return;
          case 'resolved': {
            const { resolution } = classification;
            try {
              await postedOrders.recordOutcome(record.orderHash, resolution);
              summary.resolved += 1;
              summary.byOutcome[resolution.outcome] = (summary.byOutcome[resolution.outcome] ?? 0) + 1;
            } catch (e) {
              summary.failedWrites += 1;
              log.warn(
                { orderHash: record.orderHash, error: e instanceof Error ? e.message : e },
                'failed to record order outcome'
              );
            }
            return;
          }
        }
      });
      await Promise.all(writes);
    }

    log.info({ summary }, 'resolved pending order outcomes');
    return summary;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
