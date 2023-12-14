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
    const toUpdate: [string, number][] = [
      ['0x1', 1],
      ['0x2', 2],
      ['0x3', 3],
    ];
    await expect(repo.updateTimestampsBatch(toUpdate, 4)).resolves.not.toThrow();
    const row = await repo.getFillerTimestamps('0x1');
    expect(row).toBeDefined();
    expect(row?.lastPostTimestamp).toBe(1);
  });

  it('should batch get timestamps', async () => {
    const res = await repo.getTimestampsBatch(['0x1', '0x2', '0x3']);
    expect(res.length).toBe(3);
    expect(res).toEqual(
      expect.arrayContaining([
        {
          hash: '0x1',
          lastPostTimestamp: 1,
          blockUntilTimestamp: 4,
        },
        {
          hash: '0x2',
          lastPostTimestamp: 2,
          blockUntilTimestamp: 4,
        },
        {
          hash: '0x3',
          lastPostTimestamp: 3,
          blockUntilTimestamp: 4,
        },
      ])
    );
  });
});
