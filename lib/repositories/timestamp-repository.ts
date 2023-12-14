import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Logger from 'bunyan';
import { Entity, Table } from 'dynamodb-toolbox';

import { DYNAMO_TABLE_KEY, DYNAMO_TABLE_NAME } from '../constants';
import { BaseTimestampRepository, DynamoTimestampRepoRow, TimestampRepoRow } from './base';

export type BatchGetResponse = {
  tableName: string;
};

export class TimestampRepository implements BaseTimestampRepository {
  static log: Logger;
  static PARTITION_KEY = 'hash';

  static create(documentClient: DynamoDBDocumentClient): BaseTimestampRepository {
    this.log = Logger.createLogger({
      name: 'DynamoTimestampRepository',
      serializers: Logger.stdSerializers,
    });
    delete this.log.fields.pid;
    delete this.log.fields.hostname;

    const table = new Table({
      name: DYNAMO_TABLE_NAME.TIMESTAMP,
      partitionKey: TimestampRepository.PARTITION_KEY,
      DocumentClient: documentClient,
    });

    const entity = new Entity({
      name: 'FillerTimestampEntity',
      attributes: {
        [TimestampRepository.PARTITION_KEY]: { partitionKey: true, type: 'string' },
        [`${DYNAMO_TABLE_KEY.LAST_POST_TIMESTAMP}`]: { type: 'string' },
        [`${DYNAMO_TABLE_KEY.BLOCK_UNTIL_TIMESTAMP}`]: { type: 'string' },
      },
      table: table,
      autoExecute: true,
    } as const);

    return new TimestampRepository(table, entity);
  }

  private constructor(
    // eslint-disable-next-line
    private readonly table: Table<'Timestamp', 'hash', null>,
    private readonly entity: Entity
  ) {}

  public async updateTimestampsBatch(toUpdate: [string, number][], ts: number): Promise<void> {
    await this.table.batchWrite(
      toUpdate.map(([hash, postTs]) => {
        return this.entity.putBatch({
          [TimestampRepository.PARTITION_KEY]: hash,
          [`${DYNAMO_TABLE_KEY.LAST_POST_TIMESTAMP}`]: postTs,
          [`${DYNAMO_TABLE_KEY.BLOCK_UNTIL_TIMESTAMP}`]: ts,
        });
      }),
      {
        execute: true,
      }
    );
  }

  public async getFillerTimestamps(hash: string): Promise<TimestampRepoRow> {
    const { Item } = await this.entity.get(
      { hash: hash },
      {
        execute: true,
      }
    );
    TimestampRepository.log.info({ Item }, 'get result');
    return {
      hash: Item?.hash,
      lastPostTimestamp: parseInt(Item?.lastPostTimestamp),
      blockUntilTimestamp: parseInt(Item?.blockUntilTimestamp),
    };
  }

  public async getTimestampsBatch(hashes: string[]): Promise<TimestampRepoRow[]> {
    const { Responses: items } = await this.table.batchGet(
      hashes.map((hash) => {
        return this.entity.getBatch({
          [TimestampRepository.PARTITION_KEY]: hash,
        });
      }),
      {
        execute: true,
        parse: true,
      }
    );
    return items[DYNAMO_TABLE_NAME.TIMESTAMP].map((row: DynamoTimestampRepoRow) => {
      return {
        hash: row.hash,
        lastPostTimestamp: parseInt(row.lastPostTimestamp),
        blockUntilTimestamp: parseInt(row.blockUntilTimestamp),
      };
    });
  }
}
