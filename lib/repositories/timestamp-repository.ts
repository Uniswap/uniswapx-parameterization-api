import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  BatchWriteCommand,
  BatchWriteCommandInput,
  DynamoDBDocumentClient,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import Logger from 'bunyan';

import { DYNAMO_TABLE_KEY, DYNAMO_TABLE_NAME } from '../constants';
import { sleep } from '../util/time';
import { BaseTimestampRepository, TimestampRepoRow, ToUpdateTimestampRow } from './base';

/**
 * Sentinel for a filler that is not blocked (also the value for a never-blocked filler or a
 * missing attribute). Always < now for real unix seconds; also avoids equaling
 * lastExaminedTimestamp, which could briefly read as blocked under clock skew.
 */
export const UNBLOCKED_BLOCK_UNTIL_TIMESTAMP = 0;

// DynamoDB BatchWriteItem accepts at most 25 put requests per call.
const BATCH_WRITE_CHUNK = 25;
// A throttled BatchWrite returns the puts it could not apply as UnprocessedItems; they are
// retried with backoff this many times before the write is reported failed. Only the cron
// writes this table, so the backoff never sits on a quote path.
const BATCH_WRITE_UNPROCESSED_RETRIES = 3;
const BATCH_WRITE_RETRY_BASE_MS = 50;

type WriteRequests = NonNullable<BatchWriteCommandInput['RequestItems']>[string];

// Stored shape of a row. Every attribute but the key can be missing (rows written before an
// attribute existed, or a put that omitted an undefined value), so reads default each one.
type StoredTimestampRow = Partial<TimestampRepoRow>;

// The circuit-breaker state is small integers (unix seconds, small counts), so it is stored
// as native DynamoDB numbers and read with a wrapNumbers:false client — no string parsing,
// and a missing attribute reads as undefined (guarded with ?? below) rather than NaN.
function circuitBreakerDocumentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { convertEmptyValues: true },
    unmarshallOptions: { wrapNumbers: false },
  });
}

export class TimestampRepository implements BaseTimestampRepository {
  static log: Logger;
  static PARTITION_KEY = 'hash';

  static create(documentClient: DynamoDBDocumentClient = circuitBreakerDocumentClient()): BaseTimestampRepository {
    this.log = Logger.createLogger({
      name: 'DynamoTimestampRepository',
      serializers: Logger.stdSerializers,
    });
    delete this.log.fields.pid;
    delete this.log.fields.hostname;

    return new TimestampRepository(documentClient);
  }

  private constructor(private readonly documentClient: DynamoDBDocumentClient) {}

  /** Full-item put per row: an attribute left undefined is omitted, so its read defaults apply. */
  public async updateTimestampsBatch(updatedTimestamps: ToUpdateTimestampRow[]): Promise<void> {
    const table = DYNAMO_TABLE_NAME.FILLER_CB_TIMESTAMPS_V2;
    for (let i = 0; i < updatedTimestamps.length; i += BATCH_WRITE_CHUNK) {
      let requests: WriteRequests = updatedTimestamps
        .slice(i, i + BATCH_WRITE_CHUNK)
        .map((row) => ({ PutRequest: { Item: toItem(row) } }));
      for (let attempt = 0; ; attempt++) {
        const { UnprocessedItems } = await this.documentClient.send(
          new BatchWriteCommand({ RequestItems: { [table]: requests } })
        );
        const unprocessed = UnprocessedItems?.[table] ?? [];
        if (unprocessed.length === 0) break;
        if (attempt >= BATCH_WRITE_UNPROCESSED_RETRIES) {
          throw new Error(
            `${table} BatchWrite left ${unprocessed.length} puts unprocessed after ${BATCH_WRITE_UNPROCESSED_RETRIES} retries`
          );
        }
        await sleep(BATCH_WRITE_RETRY_BASE_MS * 2 ** attempt);
        requests = unprocessed;
      }
    }
  }

  public async getFillerTimestamps(hash: string): Promise<TimestampRepoRow> {
    const { Item } = await this.documentClient.send(
      new GetCommand({
        TableName: DYNAMO_TABLE_NAME.FILLER_CB_TIMESTAMPS_V2,
        Key: { [TimestampRepository.PARTITION_KEY]: hash },
      })
    );
    return toRow(hash, Item as StoredTimestampRow | undefined);
  }

  /**
   * One BatchGet for all hashes (the caller passes deduped endpoints, fewer than DynamoDB's 100-key
   * cap). This read sits on the quote path, so keys DynamoDB leaves unprocessed are not retried
   * with backoff here; they are warned about and read as unblocked until the provider's next
   * refresh, as before.
   */
  public async getTimestampsBatch(hashes: string[]): Promise<TimestampRepoRow[]> {
    const table = DYNAMO_TABLE_NAME.FILLER_CB_TIMESTAMPS_V2;
    const { Responses, UnprocessedKeys } = await this.documentClient.send(
      new BatchGetCommand({
        RequestItems: { [table]: { Keys: hashes.map((hash) => ({ [TimestampRepository.PARTITION_KEY]: hash })) } },
      })
    );
    const unprocessed = UnprocessedKeys?.[table]?.Keys?.length ?? 0;
    if (unprocessed > 0) {
      TimestampRepository.log.warn(
        { unprocessed, requested: hashes.length },
        `${table} BatchGet left keys unprocessed; those fillers read as unblocked until the next refresh`
      );
    }
    return ((Responses?.[table] ?? []) as StoredTimestampRow[]).map((row) => toRow(row.hash ?? '', row));
  }

  public async getFillerTimestampsMap(hashes: string[]): Promise<Map<string, Omit<TimestampRepoRow, 'hash'>>> {
    const rows = await this.getTimestampsBatch(hashes);
    const res = new Map<string, Omit<TimestampRepoRow, 'hash'>>();
    rows.forEach((row) => {
      res.set(row.hash, {
        lastExaminedTimestamp: row.lastExaminedTimestamp,
        blockUntilTimestamp: row.blockUntilTimestamp,
        fadeWindowStart: row.fadeWindowStart,
        consecutiveBlocks: row.consecutiveBlocks,
        consecutiveCleanRuns: row.consecutiveCleanRuns,
      });
    });
    return res;
  }
}

function toItem(row: ToUpdateTimestampRow): Record<string, string | number> {
  const item: Record<string, string | number | undefined> = {
    [TimestampRepository.PARTITION_KEY]: row.hash,
    [DYNAMO_TABLE_KEY.LAST_EXAMINED_TIMESTAMP]: row.lastExaminedTimestamp,
    [DYNAMO_TABLE_KEY.BLOCK_UNTIL_TIMESTAMP]: row.blockUntilTimestamp,
    [DYNAMO_TABLE_KEY.FADE_WINDOW_START]: row.fadeWindowStart,
    [DYNAMO_TABLE_KEY.CONSECUTIVE_BLOCKS]: row.consecutiveBlocks,
    [DYNAMO_TABLE_KEY.CONSECUTIVE_CLEAN_RUNS]: row.consecutiveCleanRuns,
  };
  return Object.fromEntries(
    Object.entries(item).filter((entry): entry is [string, string | number] => entry[1] !== undefined)
  );
}

function toRow(hash: string, item: StoredTimestampRow | undefined): TimestampRepoRow {
  return {
    hash: item?.hash ?? hash,
    lastExaminedTimestamp: item?.lastExaminedTimestamp ?? 0,
    blockUntilTimestamp: item?.blockUntilTimestamp ?? UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
    fadeWindowStart: item?.fadeWindowStart ?? UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
    consecutiveBlocks: item?.consecutiveBlocks ?? 0,
    consecutiveCleanRuns: item?.consecutiveCleanRuns ?? 0,
  };
}
