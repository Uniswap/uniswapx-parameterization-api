import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, BatchGetCommandInput, DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import Logger from 'bunyan';

import { getAddress } from 'ethers/lib/utils';
import { DYNAMO_TABLE_NAME } from '../constants';
import { sleep } from '../util/time';
import { postedOrderDocumentClient } from './posted-order-repository';

/**
 * How long an address -> filler attribution lives after the filler last won a quote with it.
 * The fade breaker only looks back 24h (OrderServiceFadesSource) and the backtest extract 28d, so
 * a 30d TTL keeps every attribution either of them can ask about while letting the addresses
 * of a filler that rotates per quote age out instead of accumulating forever.
 */
export const FILLER_ADDRESS_TTL_SECS = 30 * 24 * 60 * 60;

/**
 * Attempts the attribution write gets from the SDK before it is reported failed. The write is
 * made once per confirmed win and a miss leaves a new address unattributed until its next win,
 * so it is worth one retry; the recorder's wall (POSTED_ORDER_WRITE_TIMEOUT_MS) still bounds
 * the total, so the retry can only ever spend time the response was already going to wait.
 */
export const FILLER_ADDRESS_WRITE_MAX_ATTEMPTS = 2;

// DynamoDB BatchGetItem accepts at most 100 keys per request.
const BATCH_GET_CHUNK = 100;
// A throttled BatchGet returns the keys it could not serve as UnprocessedKeys; they are retried
// with backoff this many times before the remainder is given up (and logged) for this call.
const BATCH_GET_UNPROCESSED_RETRIES = 3;
const BATCH_GET_RETRY_BASE_MS = 50;

type BatchGetKeys = NonNullable<NonNullable<BatchGetCommandInput['RequestItems']>[string]['Keys']>;

/**
 * Outcome of recordWinningAddress. `owned_by_other` is a refused claim: the address is already
 * attributed to a different endpoint and stays that way. `existingOwner` is absent only when
 * DynamoDB did not return the conflicting item.
 */
export type WinningAddressClaim = { outcome: 'recorded' } | { outcome: 'owned_by_other'; existingOwner?: string };

/**
 * Maps on-chain filler addresses to the RFQ webhook (filler) that quotes with them.
 *
 * One item per address (pk = checksummed address, filler = webhook endpoint, expiresAt = TTL).
 * The mapping has one runtime reader: the fade-rate breaker, whose rows are keyed by a posted
 * order's exclusive filler address and which needs the webhook to bench (lookupFillersForRows in
 * lib/core/circuit-breaker.ts; the backtest extract described in CLAUDE.md scans the table offline). Only a quote that WON produces a posted
 * order, so only winning addresses are recorded (by recordPostedOrder, alongside the
 * PostedOrders row, at the confirmed post), and there is no per-filler address cap: a filler
 * may quote from as many addresses as it likes, each costing one read-free conditional write
 * per posted order and expiring FILLER_ADDRESS_TTL_SECS after its last win. Nothing on the
 * /quote path reads or writes this table. (The PostedOrders row also carries the endpoint per
 * order, frozen at post time; attributing through this table at read time is what lets a
 * filler's history follow an endpoint rename.)
 */
export interface FillerAddressRepository {
  /**
   * Attribute `address` to `filler` because a quote from `filler` carrying `address` won.
   * First-writer-wins: an address already attributed to a different filler keeps its owner, so
   * one filler cannot poison another's attribution. The refused claim is reported (not thrown)
   * so the caller can count it; the row's TTL is not refreshed by it, so the stale attribution
   * expires FILLER_ADDRESS_TTL_SECS after the old owner's last win. A genuine address migration
   * between endpoints (a filler whose webhook URL changed) needs the row deleted by hand until
   * then. Re-recording for the same owner refreshes the TTL.
   */
  recordWinningAddress(address: string, filler: string): Promise<WinningAddressClaim>;
  /** address -> filler for exactly the addresses asked (keys checksummed); unknown addresses absent. */
  getAddressToFillerMap(addresses: string[]): Promise<Map<string, string>>;
}

type AddressItem = {
  pk: string;
  filler?: string;
  expiresAt?: number;
};

export class DynamoFillerAddressRepository implements FillerAddressRepository {
  static log: Logger;

  /**
   * The default client is the sibling PostedOrders write's bounded one (short connect/request
   * ceilings) with one retry: on the hard-quote path this write sits in series with the
   * response, and the recorder's wall caps the total. The cron passes its own unbounded client,
   * since its BatchGets are not latency-sensitive and would be brittle under those ceilings.
   */
  static create(
    documentClient: DynamoDBDocumentClient = postedOrderDocumentClient(FILLER_ADDRESS_WRITE_MAX_ATTEMPTS),
    now: () => number = Date.now
  ): FillerAddressRepository {
    this.log = Logger.createLogger({
      name: 'FillerAddressRepository',
      serializers: Logger.stdSerializers,
    });
    // Rows written before per-address TTLs existed have no expiresAt; they keep resolving and get
    // a TTL on their next win. An address whose owner never wins again keeps its pre-TTL row
    // until a one-off backfill stamps expiresAt. The table also still holds legacy
    // filler -> [addresses] rows keyed by endpoint URL; they are never requested by address and
    // can be deleted at leisure.
    return new DynamoFillerAddressRepository(documentClient, now);
  }

  private constructor(private readonly documentClient: DynamoDBDocumentClient, private readonly _now: () => number) {}

  async recordWinningAddress(address: string, filler: string): Promise<WinningAddressClaim> {
    const addr = getAddress(address);
    const nowMs = this._now();
    try {
      await this.documentClient.send(
        new UpdateCommand({
          TableName: DYNAMO_TABLE_NAME.FILLER_ADDRESS,
          Key: { pk: addr },
          UpdateExpression: 'SET #filler = :filler, #expiresAt = :expiresAt',
          // unclaimed, or already ours (TTL refresh). Anything else is another filler's address.
          ConditionExpression: 'attribute_not_exists(#filler) OR #filler = :filler',
          ExpressionAttributeNames: { '#filler': 'filler', '#expiresAt': 'expiresAt' },
          ExpressionAttributeValues: {
            ':filler': filler,
            ':expiresAt': Math.floor(nowMs / 1000) + FILLER_ADDRESS_TTL_SECS,
          },
          // Ship the conflicting row back with the failure so the refusal can name the owner
          // without a second round trip.
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        })
      );
      return { outcome: 'recorded' };
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) {
        throw err;
      }
      // The exception carries the raw (marshalled) item; the document client does not unmarshall it.
      const existingOwner = err.Item?.filler?.S;
      DynamoFillerAddressRepository.log.info(
        { address: addr, attemptedOwner: filler, existingOwner },
        'address already owned by another filler; ignoring claim'
      );
      return { outcome: 'owned_by_other', existingOwner };
    }
  }

  async getAddressToFillerMap(addresses: string[]): Promise<Map<string, string>> {
    const table = DYNAMO_TABLE_NAME.FILLER_ADDRESS;
    const unique = [...new Set(addresses.map((a) => getAddress(a)))];
    const resMap = new Map<string, string>();
    let pagesWithoutTable = 0;
    let unprocessed = 0;

    for (let i = 0; i < unique.length; i += BATCH_GET_CHUNK) {
      let keys: BatchGetKeys = unique.slice(i, i + BATCH_GET_CHUNK).map((pk) => ({ pk }));
      // DynamoDB may serve only part of a batch under throttling and return the rest as
      // UnprocessedKeys; they are re-requested with backoff. Dropping them would silently leave
      // those fillers unscored for this run.
      for (let attempt = 0; ; attempt++) {
        const { Responses, UnprocessedKeys } = await this.documentClient.send(
          new BatchGetCommand({ RequestItems: { [table]: { Keys: keys } } })
        );
        // Responses is keyed by the table's physical name. A page without our entry is not
        // "no rows" — every requested key would then be silently unattributed.
        const served = Responses?.[table] as AddressItem[] | undefined;
        if (served) {
          served.forEach((row) => {
            if (row.filler) {
              resMap.set(getAddress(row.pk), row.filler);
            }
          });
        } else {
          pagesWithoutTable++;
        }
        keys = UnprocessedKeys?.[table]?.Keys ?? [];
        if (keys.length === 0 || attempt >= BATCH_GET_UNPROCESSED_RETRIES) break;
        await sleep(BATCH_GET_RETRY_BASE_MS * 2 ** attempt);
      }
      unprocessed += keys.length;
    }
    if (pagesWithoutTable > 0) {
      DynamoFillerAddressRepository.log.warn(
        { pagesWithoutTable, table, requested: unique.length },
        'FillerAddress BatchGet pages carried no entry for the table; their addresses are unattributed this run'
      );
    }
    if (unprocessed > 0) {
      DynamoFillerAddressRepository.log.warn(
        { unprocessed, requested: unique.length },
        'FillerAddress BatchGet left keys unprocessed after retries; those addresses are unattributed this run'
      );
    }
    DynamoFillerAddressRepository.log.info(
      { requested: unique.length, resolved: resMap.size, unprocessed },
      'filler addresses from dynamo'
    );
    return resMap;
  }
}

/** In-memory fake with the same first-writer-wins semantics, for handler and cron tests. */
export class MockFillerAddressRepository implements FillerAddressRepository {
  public readonly addressToFiller = new Map<string, string>();
  public readonly requestedAddresses: string[][] = [];

  async recordWinningAddress(address: string, filler: string): Promise<WinningAddressClaim> {
    const addr = getAddress(address);
    const existingOwner = this.addressToFiller.get(addr);
    if (existingOwner && existingOwner !== filler) {
      return { outcome: 'owned_by_other', existingOwner };
    }
    this.addressToFiller.set(addr, filler);
    return { outcome: 'recorded' };
  }

  async getAddressToFillerMap(addresses: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(addresses.map((a) => getAddress(a)))];
    this.requestedAddresses.push(unique);
    const res = new Map<string, string>();
    for (const addr of unique) {
      const filler = this.addressToFiller.get(addr);
      if (filler) {
        res.set(addr, filler);
      }
    }
    return res;
  }
}
