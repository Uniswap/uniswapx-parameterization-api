import { DynamoDBClient, DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getAddress } from 'ethers/lib/utils';

import {
  DynamoFillerAddressRepository,
  FILLER_ADDRESS_TTL_SECS,
  FillerAddressRepository,
} from '../../lib/repositories/filler-address-repository';

const dynamoConfig: DynamoDBClientConfig = {
  endpoint: 'http://localhost:8000',
  region: 'local',
  credentials: {
    accessKeyId: 'fakeMyKeyId',
    secretAccessKey: 'fakeSecretAccessKey',
  },
};

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(dynamoConfig), {
  marshallOptions: {
    convertEmptyValues: true,
  },
  unmarshallOptions: {
    wrapNumbers: true,
  },
});

// Controllable clock so TTL refresh is testable without waiting.
let nowMs = 1_800_000_000_000;
const repository: FillerAddressRepository = DynamoFillerAddressRepository.create(documentClient, () => nowMs);

const FILLER1 = 'https://filler-1.example/rfq';
const FILLER2 = 'https://filler-2.example/rfq';
const ADDR1 = '0x0000000000000000000000000000000000000001';
const ADDR2 = '0x0000000000000000000000000000000000000002';
const ADDR3 = '0x0000000000000000000000000000000000000003';

const CHECKSUMED_ADDR = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const LOWER_CASE_ADDR = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);

async function rawItem(pk: string): Promise<Record<string, unknown> | undefined> {
  const { Item } = await documentClient.send(new GetCommand({ TableName: 'FillerAddress', Key: { pk } }));
  return Item;
}

describe('filler address repository', () => {
  beforeAll(async () => {
    await repository.recordWinningAddress(ADDR1, FILLER1);
    await repository.recordWinningAddress(ADDR2, FILLER1);
    await repository.recordWinningAddress(ADDR3, FILLER2);
    await repository.recordWinningAddress(LOWER_CASE_ADDR, FILLER2);
  });

  it('resolves a recorded address to its filler', async () => {
    expect(await repository.getFillerByAddress(ADDR1)).toEqual(FILLER1);
    expect(await repository.getFillerByAddress(ADDR2)).toEqual(FILLER1);
    expect(await repository.getFillerByAddress(ADDR3)).toEqual(FILLER2);
    expect(await repository.getFillerByAddress('0x00000000000000000000000000000000000000ff')).toBeUndefined();
  });

  it('checksums addresses on write and on read', async () => {
    expect(await repository.getFillerByAddress(LOWER_CASE_ADDR)).toEqual(FILLER2);
    expect(await rawItem(CHECKSUMED_ADDR)).toMatchObject({ pk: CHECKSUMED_ADDR, filler: FILLER2 });
    expect(await rawItem(LOWER_CASE_ADDR)).toBeUndefined();
  });

  it('stamps a TTL of FILLER_ADDRESS_TTL_SECS from the write time', async () => {
    const item = await rawItem(ADDR1);
    expect(Number(item?.expiresAt)).toEqual(Math.floor(nowMs / 1000) + FILLER_ADDRESS_TTL_SECS);
  });

  it('batch-resolves exactly the addresses asked, keyed by checksummed address', async () => {
    const res = await repository.getAddressToFillerMap([ADDR1, ADDR3, LOWER_CASE_ADDR, addr(0xdead)]);
    expect(res).toEqual(
      new Map([
        [ADDR1, FILLER1],
        [ADDR3, FILLER2],
        [CHECKSUMED_ADDR, FILLER2],
      ])
    );
  });

  it('first-writer-wins: a claim on another filler address is ignored, not thrown', async () => {
    await expect(repository.recordWinningAddress(ADDR1, 'https://attacker.example/rfq')).resolves.toBeUndefined();
    expect(await repository.getFillerByAddress(ADDR1)).toEqual(FILLER1);
  });

  it('has no per-filler address cap', async () => {
    const many = Array.from({ length: 12 }, (_, i) => addr(0x1000 + i));
    for (const a of many) {
      await repository.recordWinningAddress(a, FILLER1);
    }
    const res = await repository.getAddressToFillerMap(many);
    expect(res.size).toEqual(many.length);
    expect([...res.values()].every((f) => f === FILLER1)).toBe(true);
  });

  it('chunks batch lookups past the 100-key BatchGet limit', async () => {
    const many = Array.from({ length: 105 }, (_, i) => addr(0x2000 + i));
    for (const a of many) {
      await repository.recordWinningAddress(a, FILLER2);
    }
    const res = await repository.getAddressToFillerMap([...many, addr(0xbeef)]);
    expect(res.size).toEqual(105);
  });

  describe('TTL refresh', () => {
    const A = addr(0x3001);

    it('re-recording for the same owner refreshes the TTL with a single write and no read', async () => {
      await repository.recordWinningAddress(A, FILLER1);
      const before = Number((await rawItem(A))?.expiresAt);
      nowMs += 1_000_000;
      const send = jest.spyOn(documentClient, 'send');
      try {
        await repository.recordWinningAddress(A, FILLER1);
        expect(send).toHaveBeenCalledTimes(1);
      } finally {
        send.mockRestore();
      }
      const after = Number((await rawItem(A))?.expiresAt);
      expect(after).toBeGreaterThan(before);
      expect(after).toEqual(Math.floor(nowMs / 1000) + FILLER_ADDRESS_TTL_SECS);
    });

    it('an ignored claim by another filler changes neither the owner nor the TTL', async () => {
      const before = Number((await rawItem(A))?.expiresAt);
      nowMs += 1_000_000;
      await repository.recordWinningAddress(A, 'https://other.example/rfq');
      const item = await rawItem(A);
      expect(item?.filler).toEqual(FILLER1);
      expect(Number(item?.expiresAt)).toEqual(before);
    });
  });

  it('still resolves address rows written before per-address TTLs existed (no migration)', async () => {
    // Shape of a pre-TTL row: dynamodb-toolbox entity marker, no expiresAt.
    const legacy = addr(0x4001);
    await documentClient.send(
      new PutCommand({
        TableName: 'FillerAddress',
        Item: { pk: legacy, filler: FILLER2, entity: 'addressToFillerEntity' },
      })
    );
    expect(await repository.getFillerByAddress(legacy)).toEqual(FILLER2);
    expect(await repository.getAddressToFillerMap([legacy])).toEqual(new Map([[legacy, FILLER2]]));

    // and its first win under the new code gives it a TTL without changing its owner
    await repository.recordWinningAddress(legacy, FILLER2);
    const item = await rawItem(legacy);
    expect(item).toMatchObject({ filler: FILLER2 });
    expect(Number(item?.expiresAt)).toBeGreaterThan(0);
  });

  it('ignores legacy filler -> [addresses] rows, which are keyed by endpoint and never requested', async () => {
    // Pre-redesign shape; must not break batch lookups that happen to share the table.
    await documentClient.send(
      new PutCommand({
        TableName: 'FillerAddress',
        Item: { pk: FILLER1, addresses: new Set([ADDR1, ADDR2]), entity: 'fillerToAddressEntity' },
      })
    );
    const res = await repository.getAddressToFillerMap([ADDR1, ADDR2]);
    expect(res).toEqual(
      new Map([
        [ADDR1, FILLER1],
        [ADDR2, FILLER1],
      ])
    );
  });
});
