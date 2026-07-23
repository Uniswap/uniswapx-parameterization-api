import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

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
      },
      {
        hash: '0x2',
        lastExaminedTimestamp: 2,
        blockUntilTimestamp: 5,
        fadeWindowStart: 5,
        consecutiveBlocks: 0,
      },
      {
        hash: '0x3',
        lastExaminedTimestamp: 3,
        blockUntilTimestamp: 6,
        fadeWindowStart: 4,
        consecutiveBlocks: 1,
        fadedOrderHashes: ['0xfaded1', '0xfaded2'],
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
    // written without fadedOrderHashes (legacy shape) — reads back as undefined
    expect(row?.fadedOrderHashes).toBeUndefined();

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
    expect(row?.fadedOrderHashes).toEqual(['0xfaded1', '0xfaded2']);
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
        },
        {
          hash: '0x2',
          lastExaminedTimestamp: 2,
          blockUntilTimestamp: 5,
          fadeWindowStart: 5,
          consecutiveBlocks: 0,
        },
        {
          hash: '0x3',
          lastExaminedTimestamp: 3,
          blockUntilTimestamp: 6,
          fadeWindowStart: 4,
          consecutiveBlocks: 1,
          fadedOrderHashes: ['0xfaded1', '0xfaded2'],
        },
      ])
    );
  });
});
