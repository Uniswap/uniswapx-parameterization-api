import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Logger from 'bunyan';
import { Entity, Table } from 'dynamodb-toolbox';

import { DYNAMO_TABLE_NAME } from '../constants';

export type DynamoFillerToAddressRow = {
  pk: string;
  addresses: string[];
};

export interface FillerAddressRepository {
  getFillerAddresses(filler: string): Promise<string[] | undefined>;
  getFillerByAddress(address: string): Promise<string | undefined>;
  addNewAddressToFiller(address: string, filler?: string): Promise<void>;
  getFillerAddressesBatch(fillers: string[]): Promise<Map<string, Set<string>>>;
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
    return result.Item?.addresses;
  }

  async getFillerByAddress(address: string): Promise<string | undefined> {
    const result = await this._addressToFillerEntity.get({ pk: address }, { execute: true, parse: true });
    return result.Item?.filler;
  }

  async addNewAddressToFiller(address: string, filler?: string): Promise<void> {
    await this._addressToFillerEntity.put({ pk: address, filler: filler });
    if (filler) {
      const fillerAddresses = await this.getFillerAddresses(filler);
      if (!fillerAddresses || fillerAddresses.length === 0) {
        await this._fillerToAddressEntity.put({ pk: filler, addresses: [address] });
      } else {
        await this._fillerToAddressEntity.update({ pk: filler, addresses: { $add: [address] } });
      }
    } else {
      const existingFiller = await this.getFillerByAddress(address);
      if (!existingFiller) {
        throw new Error(`Filler not found for address ${address}`);
      }
      await this._fillerToAddressEntity.update({ pk: existingFiller, addresses: { $add: [address] } });
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

    const resMap = new Map<string, Set<string>>();
    items.FillerAddress.forEach((row: DynamoFillerToAddressRow) => {
      resMap.set(row.pk, new Set<string>(row.addresses));
    });
    return resMap;
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
    if (filler) {
      const fillerAddresses = this._fillerToAddress.get(filler) || new Set<string>();
      fillerAddresses.add(address);
      this._fillerToAddress.set(filler, fillerAddresses);
      this._addressToFiller.set(address, filler);
    } else {
      const existingFiller = this._addressToFiller.get(address);
      if (!existingFiller) {
        throw new Error(`Filler not found for address ${address}`);
      }
      const fillerAddresses = this._fillerToAddress.get(existingFiller) || new Set<string>();
      fillerAddresses.add(address);
      this._fillerToAddress.set(existingFiller, fillerAddresses);
    }
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
}
