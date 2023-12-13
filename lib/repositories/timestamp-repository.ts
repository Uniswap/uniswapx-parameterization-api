import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Logger from 'bunyan';
import { Entity, Table } from 'dynamodb-toolbox';

import { DYNAMO_TABLE_KEY, DYNAMO_TABLE_NAME } from '../constants';
import { BaseTimestampRepository } from './base';

export class TimestampRepository implements BaseTimestampRepository {
  static log: Logger;
  static PARTITION_KEY = 'hash';

  static create(documentClient: DynamoDBDocumentClient): BaseTimestampRepository {
    this.log = Logger.createLogger({
      name: 'DynamoTimestampRepository',
      serializers: Logger.stdSerializers,
    });

    const table = new Table({
      name: DYNAMO_TABLE_NAME.TIMESTAMP,
      partitionKey: TimestampRepository.PARTITION_KEY,
      DocumentClient: documentClient,
    });

    const entity = new Entity({
      name: 'SynthSwitchEntity',
      attributes: {
        [TimestampRepository.PARTITION_KEY]: { partitionKey: true },
        [`${DYNAMO_TABLE_KEY.TIMESTAMP}`]: { type: 'number' },
      },
      table: table,
      autoExecute: true,
    } as const);

    return new TimestampRepository(table, entity);
  }

  private constructor(
    // eslint-disable-next-line
    // @ts-expect-error
    private readonly _switchTable: Table<'Timestamp', 'hash', null>,
    private readonly entity: Entity
  ) {}

  public async updateTimestamp(hash: string, ts: number): Promise<void> {
    await this.entity.put(
      {
        [TimestampRepository.PARTITION_KEY]: hash,
        [`${DYNAMO_TABLE_KEY.TIMESTAMP}`]: ts,
      },
      {
        execute: true,
      }
    );
  }
}
