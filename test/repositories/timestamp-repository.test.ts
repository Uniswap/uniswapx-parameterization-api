import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TimestampRepository } from '../../lib/repositories/timestamp-repository';
import { DYNAMO_CONFIG } from './shared';

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(DYNAMO_CONFIG), {
  marshallOptions: {
    convertEmptyValues: true,
  },
  unmarshallOptions: {
    wrapNumbers: true,
  },
});

const repo = TimestampRepository.create(documentClient);

describe('Dynamo TimestampRepo tests', () => {
  it('should batch put timestamps', async () => {
    const toUpdate: [string, number, number?][] = [
      ['0x1', 1],
      ['0x2', 2, 5],
      ['0x3', 3, 6],
    ];
    await expect(repo.updateTimestampsBatch(toUpdate)).resolves.not.toThrow();
    let row = await repo.getFillerTimestamps('0x1');
    expect(row).toBeDefined();
    expect(row?.lastPostTimestamp).toBe(1);
    expect(row?.blockUntilTimestamp).toBe(NaN);

    row = await repo.getFillerTimestamps('0x2');
    expect(row).toBeDefined();
    expect(row?.lastPostTimestamp).toBe(2);
    expect(row?.blockUntilTimestamp).toBe(5);

    row = await repo.getFillerTimestamps('0x3');
    expect(row).toBeDefined();
    expect(row?.lastPostTimestamp).toBe(3);
    expect(row?.blockUntilTimestamp).toBe(6);
  });

  it('should batch get timestamps', async () => {
    const res = await repo.getTimestampsBatch(['0x1', '0x2', '0x3']);
    expect(res.length).toBe(3);
    expect(res).toEqual(
      expect.arrayContaining([
        {
          hash: '0x1',
          lastPostTimestamp: 1,
          blockUntilTimestamp: NaN,
        },
        {
          hash: '0x2',
          lastPostTimestamp: 2,
          blockUntilTimestamp: 5,
        },
        {
          hash: '0x3',
          lastPostTimestamp: 3,
          blockUntilTimestamp: 6,
        },
      ])
    );
  });
});
