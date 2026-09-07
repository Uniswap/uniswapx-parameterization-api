import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Logger from 'bunyan';
import { Entity, Table } from 'dynamodb-toolbox';

import { getAddress } from 'ethers/lib/utils';
import { DYNAMO_TABLE_NAME } from '../constants';

/**
 * How long an address -> filler attribution lives after the filler last won a quote with it.
 * The fade breaker only looks back 24h (V2FadesRepository) and the backtest extract 28d, so
 * a 30d TTL keeps every attribution either of them can ask about while letting the addresses
 * of a filler that rotates per quote age out instead of accumulating forever.
 */
export const FILLER_ADDRESS_TTL_SECS = 30 * 24 * 60 * 60;

// DynamoDB BatchGetItem accepts at most 100 keys per request.
const BATCH_GET_CHUNK = 100;

/**
 * Maps on-chain filler addresses to the RFQ webhook (filler) that quotes with them.
 *
 * One item per address (pk = checksummed address, filler = webhook endpoint, expiresAt = TTL).
 * The mapping exists for exactly one reader: the fade-rate breaker, which sees a posted order's
 * exclusive filler address and needs the webhook to bench. Only a quote that WON produces a
 * posted order, so only winning addresses are recorded (by the hard-quote handler, at the
 * confirmed post), and there is no per-filler address cap: a filler may quote from as many
 * addresses as it likes, each costing one read-free conditional write per posted order and
 * expiring FILLER_ADDRESS_TTL_SECS after its last win. Nothing on the /quote path reads or
 * writes this table.
 */
export interface FillerAddressRepository {
  /**
   * Attribute `address` to `filler` because a quote from `filler` carrying `address` won.
   * First-writer-wins: an address already attributed to a different filler keeps its owner (a
   * claim from another endpoint is logged and ignored, so one filler cannot poison another's
   * attribution). Re-recording for the same owner refreshes the TTL.
   */
  recordWinningAddress(address: string, filler: string): Promise<void>;
  /** address -> filler for exactly the addresses asked (keys checksummed); unknown addresses absent. */
  getAddressToFillerMap(addresses: string[]): Promise<Map<string, string>>;
  getFillerByAddress(address: string): Promise<string | undefined>;
}

type AddressItem = {
  pk: string;
  filler: string;
  expiresAt?: number;
};

export class DynamoFillerAddressRepository implements FillerAddressRepository {
  static log: Logger;

  static create(documentClient: DynamoDBDocumentClient, now: () => number = Date.now): FillerAddressRepository {
    this.log = Logger.createLogger({
      name: 'FillerAddressRepository',
      serializers: Logger.stdSerializers,
    });

    const addressTable = new Table({
      name: DYNAMO_TABLE_NAME.FILLER_ADDRESS,
      partitionKey: 'pk',
      DocumentClient: documentClient,
    });

    // The entity name is load-bearing: rows written before per-address TTLs existed carry
    // entity = 'addressToFillerEntity' and must keep parsing, so no data migration is needed.
    // (The table also still holds legacy filler -> [addresses] rows keyed by endpoint URL; they
    // are never requested by address and are simply dead weight until deleted.)
    const addressEntity = new Entity({
      name: 'addressToFillerEntity',
      attributes: {
        pk: { partitionKey: true },
        filler: { type: 'string' },
        expiresAt: { type: 'number' },
      },
      table: addressTable,
      autoExecute: true,
    } as const);

    return new DynamoFillerAddressRepository(addressTable, addressEntity, now);
  }

  private constructor(
    private readonly _addressTable: Table<'FillerAddress', 'pk', null>,
    private readonly _addressEntity: Entity,
    private readonly _now: () => number
  ) {}

  async recordWinningAddress(address: string, filler: string): Promise<void> {
    const addr = getAddress(address);
    const nowMs = this._now();
    try {
      await this._addressEntity.update(
        { pk: addr, filler, expiresAt: Math.floor(nowMs / 1000) + FILLER_ADDRESS_TTL_SECS },
        {
          // unclaimed, or already ours (TTL refresh). Anything else is another filler's address.
          conditions: [
            { attr: 'filler', exists: false },
            { or: true, attr: 'filler', eq: filler },
          ],
          execute: true,
        }
      );
    } catch (err) {
      if ((err as Error)?.name !== 'ConditionalCheckFailedException') {
        throw err;
      }
      DynamoFillerAddressRepository.log.info(
        { address: addr, attemptedOwner: filler },
        'address already owned by another filler; ignoring claim'
      );
    }
  }

  async getFillerByAddress(address: string): Promise<string | undefined> {
    const result = await this._addressEntity.get({ pk: getAddress(address) }, { execute: true, parse: true });
    return (result.Item as AddressItem | undefined)?.filler;
  }

  async getAddressToFillerMap(addresses: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(addresses.map((a) => getAddress(a)))];
    const resMap = new Map<string, string>();
    for (let i = 0; i < unique.length; i += BATCH_GET_CHUNK) {
      const chunk = unique.slice(i, i + BATCH_GET_CHUNK);
      const { Responses: items } = await this._addressTable.batchGet(
        chunk.map((addr) => this._addressEntity.getBatch({ pk: addr })),
        { execute: true, parse: true }
      );
      ((items?.FillerAddress ?? []) as AddressItem[]).forEach((row) => {
        if (row.filler) {
          resMap.set(getAddress(row.pk), row.filler);
        }
      });
    }
    DynamoFillerAddressRepository.log.info(
      { requested: unique.length, resolved: resMap.size },
      'filler addresses from dynamo'
    );
    return resMap;
  }
}

/** In-memory fake with the same first-writer-wins semantics, for handler and cron tests. */
export class MockFillerAddressRepository implements FillerAddressRepository {
  public readonly addressToFiller = new Map<string, string>();
  public readonly requestedAddresses: string[][] = [];

  async recordWinningAddress(address: string, filler: string): Promise<void> {
    const addr = getAddress(address);
    const existingOwner = this.addressToFiller.get(addr);
    if (existingOwner && existingOwner !== filler) {
      return;
    }
    this.addressToFiller.set(addr, filler);
  }

  async getFillerByAddress(address: string): Promise<string | undefined> {
    return this.addressToFiller.get(getAddress(address));
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
