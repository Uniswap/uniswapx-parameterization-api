import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Logger from 'bunyan';
import { Entity, Table } from 'dynamodb-toolbox';

import { DYNAMO_TABLE_KEY, DYNAMO_TABLE_NAME } from '../constants';
import { BaseTimestampRepository, DynamoTimestampRepoRow, TimestampRepoRow, ToUpdateTimestampRow } from './base';

export type BatchGetResponse = {
  tableName: string;
};

/**
 * Sentinel for a filler that has NEVER been blocked (or whose stored state is unset/corrupt).
 * Always < now for real unix seconds; also avoids equaling lastPostTimestamp, which could
 * briefly read as blocked under clock skew.
 *
 * NOTE: this is deliberately NOT written for fillers coming off a block. The fade-rate cron's
 * decay branch preserves their expired blockUntilTimestamp because it doubles as the
 * clean-slate floor of the fade-rate window (only orders completed after it are scored).
 * Overwriting it with this sentinel would erase that floor and re-score the filler's entire
 * 24h history — including the pre-block fades that got them blocked in the first place.
 */
export const UNBLOCKED_BLOCK_UNTIL_TIMESTAMP = 0;

// Rows are written with optional attributes (e.g. blockUntilTimestamp: undefined), and
// parseInt on a missing/malformed attribute yields NaN. NaN poisons downstream comparisons
// (`x > NaN` is always false), which reads as fail-open for the circuit breaker. Coerce at
// the parse boundary so consumers always see finite numbers.
function parseFiniteInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value as string);
  return Number.isFinite(parsed) ? parsed : fallback;
}

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
      name: DYNAMO_TABLE_NAME.FILLER_CB_TIMESTAMPS,
      partitionKey: TimestampRepository.PARTITION_KEY,
      DocumentClient: documentClient,
    });

    const entity = new Entity({
      name: 'FillerTimestampEntity',
      attributes: {
        [TimestampRepository.PARTITION_KEY]: { partitionKey: true, type: 'string' },
        [`${DYNAMO_TABLE_KEY.LAST_POST_TIMESTAMP}`]: { type: 'string' },
        [`${DYNAMO_TABLE_KEY.BLOCK_UNTIL_TIMESTAMP}`]: { type: 'string' },
        [`${DYNAMO_TABLE_KEY.CONSECUTIVE_BLOCKS}`]: { type: 'string' },
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

  public async updateTimestampsBatch(updatedTimestamps: ToUpdateTimestampRow[]): Promise<void> {
    await this.table.batchWrite(
      updatedTimestamps.map((row) => {
        return this.entity.putBatch({
          [TimestampRepository.PARTITION_KEY]: row.hash,
          [`${DYNAMO_TABLE_KEY.LAST_POST_TIMESTAMP}`]: row.lastPostTimestamp,
          [`${DYNAMO_TABLE_KEY.BLOCK_UNTIL_TIMESTAMP}`]: row.blockUntilTimestamp,
          [`${DYNAMO_TABLE_KEY.CONSECUTIVE_BLOCKS}`]: row.consecutiveBlocks,
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
    return {
      hash: Item?.hash,
      lastPostTimestamp: parseFiniteInt(Item?.lastPostTimestamp, 0),
      blockUntilTimestamp: parseFiniteInt(Item?.blockUntilTimestamp, UNBLOCKED_BLOCK_UNTIL_TIMESTAMP),
      consecutiveBlocks: parseFiniteInt(Item?.consecutiveBlocks, 0),
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
    return items[DYNAMO_TABLE_NAME.FILLER_CB_TIMESTAMPS].map((row: DynamoTimestampRepoRow) => {
      return {
        hash: row.hash,
        lastPostTimestamp: parseFiniteInt(row.lastPostTimestamp, 0),
        blockUntilTimestamp: parseFiniteInt(row.blockUntilTimestamp, UNBLOCKED_BLOCK_UNTIL_TIMESTAMP),
        consecutiveBlocks: parseFiniteInt(row.consecutiveBlocks, 0),
      };
    });
  }

  public async getFillerTimestampsMap(hashes: string[]): Promise<Map<string, Omit<TimestampRepoRow, 'hash'>>> {
    const rows = await this.getTimestampsBatch(hashes);
    const res = new Map<string, Omit<TimestampRepoRow, 'hash'>>();
    rows.forEach((row) => {
      res.set(row.hash, {
        lastPostTimestamp: row.lastPostTimestamp,
        blockUntilTimestamp: row.blockUntilTimestamp,
        consecutiveBlocks: row.consecutiveBlocks,
      });
    });
    return res;
  }
}
