import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import Logger from 'bunyan';

import { getAddress } from 'ethers/lib/utils';
import { DYNAMO_TABLE_NAME } from '../constants';
import { postedOrderDocumentClient } from './posted-order-repository';

/**
 * How long an address -> filler attribution lives after the filler last won a quote with it.
 * The backtest extract looks back 28d, so a 30d TTL keeps every attribution it can ask about
 * while letting the addresses of a filler that rotates per quote age out instead of
 * accumulating forever.
 */
export const FILLER_ADDRESS_TTL_SECS = 30 * 24 * 60 * 60;

/**
 * Attempts the attribution write gets from the SDK before it is reported failed. The write is
 * made once per confirmed win and a miss leaves a new address unattributed until its next win,
 * so it is worth one retry; the recorder's wall (POSTED_ORDER_WRITE_TIMEOUT_MS) still bounds
 * the total, so the retry can only ever spend time the response was already going to wait.
 */
export const FILLER_ADDRESS_WRITE_MAX_ATTEMPTS = 2;

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
 * The mapping has no runtime reader: the fade-rate breaker scores each posted order by the
 * endpoint stored on its PostedOrders row, never through this table, because the address is
 * chosen by the webhook and can name another filler's address. The backtest extract described
 * in CLAUDE.md scans the table offline to attribute order-service rows (which carry only the
 * address) to endpoints. Only a quote that WON produces a posted order, so only winning
 * addresses are recorded (by recordPostedOrder, alongside the PostedOrders row, at the
 * confirmed post), and there is no per-filler address cap: a filler may quote from as many
 * addresses as it likes, each costing one read-free conditional write per posted order and
 * expiring FILLER_ADDRESS_TTL_SECS after its last win. Nothing on the /quote path reads or
 * writes this table.
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
}

export class DynamoFillerAddressRepository implements FillerAddressRepository {
  static log: Logger;

  /**
   * The default client is the sibling PostedOrders write's bounded one (short connect/request
   * ceilings) with one retry: on the hard-quote path this write sits in series with the
   * response, and the recorder's wall caps the total.
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
}

/** In-memory fake with the same first-writer-wins semantics, for handler and cron tests. */
export class MockFillerAddressRepository implements FillerAddressRepository {
  public readonly addressToFiller = new Map<string, string>();

  async recordWinningAddress(address: string, filler: string): Promise<WinningAddressClaim> {
    const addr = getAddress(address);
    const existingOwner = this.addressToFiller.get(addr);
    if (existingOwner && existingOwner !== filler) {
      return { outcome: 'owned_by_other', existingOwner };
    }
    this.addressToFiller.set(addr, filler);
    return { outcome: 'recorded' };
  }
}
