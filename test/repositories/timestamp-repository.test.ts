import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import { ToUpdateTimestampRow } from '../../lib/repositories';
import { TimestampRepository, UNBLOCKED_BLOCK_UNTIL_TIMESTAMP } from '../../lib/repositories/timestamp-repository';
import { DYNAMO_CONFIG } from './shared';

// wrapNumbers:false so the number-typed CB attributes round-trip as native JS numbers
// (matches the client TimestampRepository builds for itself in production).
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(DYNAMO_CONFIG), {
  marshallOptions: {
    convertEmptyValues: true,
  },
  unmarshallOptions: {
    wrapNumbers: false,
  },
});

const repo = TimestampRepository.create(documentClient);

describe('Dynamo TimestampRepo tests', () => {
  it('should batch put timestamps', async () => {
    const toUpdate: ToUpdateTimestampRow[] = [
      {
        hash: '0x1',
        lastExaminedTimestamp: 1,
        blockUntilTimestamp: undefined,
        fadeWindowStart: undefined,
        consecutiveBlocks: 0,
        // simulate a pre-migration writer that never knew about the attribute (the type
        // requires it precisely so real callers can't do this silently); the put omits it
        // and the read path must default it to 0
        consecutiveCleanRuns: undefined as unknown as number,
      },
      {
        hash: '0x2',
        lastExaminedTimestamp: 2,
        blockUntilTimestamp: 5,
        fadeWindowStart: 5,
        consecutiveBlocks: 0,
        consecutiveCleanRuns: 0,
      },
      {
        hash: '0x3',
        lastExaminedTimestamp: 3,
        blockUntilTimestamp: 6,
        fadeWindowStart: 4,
        consecutiveBlocks: 1,
        consecutiveCleanRuns: 4,
      },
    ];

    await expect(repo.updateTimestampsBatch(toUpdate)).resolves.not.toThrow();

    let row = await repo.getFillerTimestamps('0x1');
    expect(row).toBeDefined();
    expect(row?.lastExaminedTimestamp).toBe(1);
    // missing attributes coerce to the unblocked sentinel (undefined ?? sentinel), not NaN
    expect(row?.blockUntilTimestamp).toBe(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP);
    expect(row?.fadeWindowStart).toBe(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP);
    expect(row?.consecutiveBlocks).toBe(0);
    expect(row?.consecutiveCleanRuns).toBe(0); // missing attribute (pre-migration row) reads as 0

    row = await repo.getFillerTimestamps('0x2');
    expect(row).toBeDefined();
    expect(row?.lastExaminedTimestamp).toBe(2);
    expect(row?.blockUntilTimestamp).toBe(5);
    expect(row?.fadeWindowStart).toBe(5);
    expect(row?.consecutiveBlocks).toBe(0);

    row = await repo.getFillerTimestamps('0x3');
    expect(row).toBeDefined();
    expect(row?.lastExaminedTimestamp).toBe(3);
    expect(row?.blockUntilTimestamp).toBe(6);
    expect(row?.fadeWindowStart).toBe(4);
    expect(row?.consecutiveBlocks).toBe(1);
    expect(row?.consecutiveCleanRuns).toBe(4);
  });

  it('should batch get timestamps', async () => {
    const res = await repo.getTimestampsBatch(['0x1', '0x2', '0x3']);
    expect(res.length).toBe(3);
    expect(res).toEqual(
      expect.arrayContaining([
        {
          hash: '0x1',
          lastExaminedTimestamp: 1,
          blockUntilTimestamp: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
          fadeWindowStart: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
          consecutiveBlocks: 0,
          consecutiveCleanRuns: 0,
        },
        {
          hash: '0x2',
          lastExaminedTimestamp: 2,
          blockUntilTimestamp: 5,
          fadeWindowStart: 5,
          consecutiveBlocks: 0,
          consecutiveCleanRuns: 0,
        },
        {
          hash: '0x3',
          lastExaminedTimestamp: 3,
          blockUntilTimestamp: 6,
          fadeWindowStart: 4,
          consecutiveBlocks: 1,
          consecutiveCleanRuns: 4,
        },
      ])
    );
  });

  it('writes more than one BatchWriteItem worth (25) of rows', async () => {
    const many: ToUpdateTimestampRow[] = Array.from({ length: 30 }, (_, i) => ({
      hash: `0xbulk${i}`,
      lastExaminedTimestamp: 100 + i,
      blockUntilTimestamp: 200 + i,
      fadeWindowStart: 150 + i,
      consecutiveBlocks: 1,
      consecutiveCleanRuns: 0,
    }));
    await repo.updateTimestampsBatch(many);
    const res = await repo.getTimestampsBatch(many.map((r) => r.hash));
    expect(res).toHaveLength(30);
    expect(res.find((r) => r.hash === '0xbulk29')?.blockUntilTimestamp).toBe(229);
  });

  it('reads a row in the shape the old dynamodb-toolbox writer stored', async () => {
    // Real rows carry toolbox bookkeeping (_et entity marker, _ct/_md timestamps).
    await documentClient.send(
      new PutCommand({
        TableName: 'FillerCBTimestampsV2',
        Item: {
          hash: '0xlegacy',
          lastExaminedTimestamp: 7,
          blockUntilTimestamp: 9,
          fadeWindowStart: 8,
          consecutiveBlocks: 2,
          consecutiveCleanRuns: 1,
          _et: 'FillerTimestampEntity',
          _ct: '2025-01-01T00:00:00.000Z',
          _md: '2025-01-01T00:00:00.000Z',
        },
      })
    );
    expect(await repo.getTimestampsBatch(['0xlegacy'])).toEqual([
      {
        hash: '0xlegacy',
        lastExaminedTimestamp: 7,
        blockUntilTimestamp: 9,
        fadeWindowStart: 8,
        consecutiveBlocks: 2,
        consecutiveCleanRuns: 1,
      },
    ]);
  });
});
