import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Logger from 'bunyan';
import { Entity, Table } from 'dynamodb-toolbox';

import { getAddress } from 'ethers/lib/utils';
import { DYNAMO_TABLE_NAME } from '../constants';

export type DynamoFillerToAddressRow = {
  pk: string;
  addresses: string[];
};

// Max distinct on-chain addresses a single filler (webhook endpoint) may register. Bounds
// Sybil breadth: without a cap a filler could register unbounded addresses to spread fades or
// inflate the circuit-breaker's row set. Rejected registrations are a safe no-op (the order
// still quotes/fills; the address just isn't attributed), so this can't break quoting.
// NOTE: tune against the real per-endpoint address distribution before tightening.
export const MAX_FILLER_ADDRESSES = 3;

export interface FillerAddressRepository {
  getFillerAddresses(filler: string): Promise<string[] | undefined>;
  getFillerByAddress(address: string): Promise<string | undefined>;
  addNewAddressToFiller(address: string, filler?: string): Promise<void>;
  getFillerAddressesBatch(fillers: string[]): Promise<Map<string, Set<string>>>;
  getAddressToFillerMap(fillers: string[]): Promise<Map<string, string>>;
}
/*
 * Dynamo repository for managing filler addresses
 * Supports two way lookups: filler -> addr, addr -> fillers
 */
export class DynamoFillerAddressRepository implements FillerAddressRepository {
  static log: Logger;

  static create(documentClient: DynamoDBDocumentClient): FillerAddressRepository {
    this.log = Logger.createLogger({
      name: 'FillerAddressRepository',
      serializers: Logger.stdSerializers,
    });

    const addressTable = new Table({
      name: DYNAMO_TABLE_NAME.FILLER_ADDRESS,
      partitionKey: 'pk', // generic partition key name to support both filler and address
      DocumentClient: documentClient,
    });

    const fillerToAddressEntity = new Entity({
      name: 'fillerToAddressEntity',
      attributes: {
        pk: { partitionKey: true },
        addresses: { type: 'set', setType: 'string' },
      },
      table: addressTable,
      autoExecute: true,
    } as const);

    const addressToFillerEntity = new Entity({
      name: 'addressToFillerEntity',
      attributes: {
        pk: { partitionKey: true },
        filler: { type: 'string' },
      },
      table: addressTable,
      autoExecute: true,
    } as const);

    return new DynamoFillerAddressRepository(addressTable, fillerToAddressEntity, addressToFillerEntity);
  }
  private constructor(
    private readonly _addressTable: Table<'FillerAddress', 'pk', null>,
    private readonly _fillerToAddressEntity: Entity,
    private readonly _addressToFillerEntity: Entity
  ) {}

  async getFillerAddresses(filler: string): Promise<string[] | undefined> {
    const result = await this._fillerToAddressEntity.get({ pk: filler }, { execute: true, parse: true });
    if (result.Item?.addresses) {
      return (result.Item.addresses as string[]).map((addr) => getAddress(addr));
    }
    return undefined;
  }

  async getFillerByAddress(address: string): Promise<string | undefined> {
    const result = await this._addressToFillerEntity.get({ pk: getAddress(address) }, { execute: true, parse: true });
    return result.Item?.filler;
  }

  async addNewAddressToFiller(address: string, filler?: string): Promise<void> {
    const addrToAdd = getAddress(address);
    const existingOwner = await this.getFillerByAddress(addrToAdd);
    const owner = filler ?? existingOwner;
    if (!owner) {
      throw new Error(`Filler not found for address ${addrToAdd}`);
    }

    // First-writer-wins: an address belongs to whichever filler registered it first. A claim
    // from a different filler is ignored (prevents attribution poisoning / griefing). A genuine
    // address migration between endpoints needs a manual override.
    if (existingOwner && existingOwner !== owner) {
      DynamoFillerAddressRepository.log.info(
        { address: addrToAdd, existingOwner, attemptedOwner: owner },
        'address already owned by another filler; ignoring claim'
      );
      return;
    }

    // Already registered to this owner — idempotent no-op.
    if (existingOwner === owner) {
      return;
    }

    // New address for this owner — enforce the per-filler cap.
    const fillerAddresses = (await this.getFillerAddresses(owner)) ?? [];
    if (fillerAddresses.length >= MAX_FILLER_ADDRESSES) {
      DynamoFillerAddressRepository.log.info(
        { filler: owner, address: addrToAdd, count: fillerAddresses.length, max: MAX_FILLER_ADDRESSES },
        'filler address cap reached; ignoring new address'
      );
      return;
    }

    await this._addressToFillerEntity.put({ pk: addrToAdd, filler: owner });
    if (fillerAddresses.length === 0) {
      await this._fillerToAddressEntity.put({ pk: owner, addresses: [addrToAdd] });
    } else {
      await this._fillerToAddressEntity.update({ pk: owner, addresses: { $add: [addrToAdd] } });
    }
  }

  /*
    @returns a map of filler -> [addresses]
  */
  async getFillerAddressesBatch(fillers: string[]): Promise<Map<string, Set<string>>> {
    const { Responses: items } = await this._addressTable.batchGet(
      fillers.map((fillerHash) => this._fillerToAddressEntity.getBatch({ pk: fillerHash })),
      { execute: true, parse: true }
    );

    DynamoFillerAddressRepository.log.info(
      { fillersAddresses: items, fillers: fillers },
      'filler addresses from dynamo'
    );
    const resMap = new Map<string, Set<string>>();
    items.FillerAddress.forEach((row: DynamoFillerToAddressRow) => {
      resMap.set(row.pk, new Set<string>(row.addresses.map((addr) => getAddress(addr))));
    });
    return resMap;
  }

  async getAddressToFillerMap(fillers: string[]): Promise<Map<string, string>> {
    const fillerAddresses = await this.getFillerAddressesBatch(fillers);
    DynamoFillerAddressRepository.log.info(
      { fillerAddressesMap: [...fillerAddresses.entries()] },
      'filler addresses map'
    );
    const addrToFillerMap = new Map<string, string>();
    fillerAddresses.forEach((addresses, hash) => {
      addresses.forEach((addr) => addrToFillerMap.set(addr, hash));
    });
    return addrToFillerMap;
  }
}

export class MockFillerAddressRepository implements FillerAddressRepository {
  private readonly _fillerToAddress: Map<string, Set<string>>;
  private readonly _addressToFiller: Map<string, string>;

  constructor() {
    this._fillerToAddress = new Map<string, Set<string>>();
    this._addressToFiller = new Map<string, string>();
  }

  async getFillerAddresses(filler: string): Promise<string[] | undefined> {
    return Array.from(this._fillerToAddress.get(filler) || []);
  }

  async getFillerByAddress(address: string): Promise<string | undefined> {
    return this._addressToFiller.get(address);
  }

  async addNewAddressToFiller(address: string, filler?: string): Promise<void> {
    const existingOwner = this._addressToFiller.get(address);
    const owner = filler ?? existingOwner;
    if (!owner) {
      throw new Error(`Filler not found for address ${address}`);
    }
    // First-writer-wins: ignore a claim on an address owned by another filler.
    if (existingOwner && existingOwner !== owner) {
      return;
    }
    // Already registered to this owner — idempotent no-op.
    if (existingOwner === owner) {
      return;
    }
    // New address for this owner — enforce the per-filler cap.
    const fillerAddresses = this._fillerToAddress.get(owner) || new Set<string>();
    if (fillerAddresses.size >= MAX_FILLER_ADDRESSES) {
      return;
    }
    fillerAddresses.add(address);
    this._fillerToAddress.set(owner, fillerAddresses);
    this._addressToFiller.set(address, owner);
  }

  async getFillerAddressesBatch(fillers: string[]): Promise<Map<string, Set<string>>> {
    const res = new Map<string, Set<string>>();
    for (const filler of fillers) {
      const addrs = await this.getFillerAddresses(filler);
      if (addrs) {
        res.set(filler, new Set(addrs));
      }
    }
    return res;
  }

  async getAddressToFillerMap(fillers: string[]): Promise<Map<string, string>> {
    const fillerAddresses = await this.getFillerAddressesBatch(fillers);
    const addrToFillerMap = new Map<string, string>();
    fillerAddresses.forEach((addresses, hash) => {
      addresses.forEach((addr) => addrToFillerMap.set(addr, hash));
    });
    return addrToFillerMap;
  }
}
