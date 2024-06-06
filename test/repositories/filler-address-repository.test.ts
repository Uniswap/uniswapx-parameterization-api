import { DynamoDBClient, DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { DynamoFillerAddressRepository } from '../../lib/repositories/filler-address-repository';

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

const repository = DynamoFillerAddressRepository.create(documentClient);

const ADDR1 = '0x0000000000000000000000000000000000000001';
const ADDR2 = '0x0000000000000000000000000000000000000002';
const ADDR3 = '0x0000000000000000000000000000000000000003';
const ADDR4 = '0x0000000000000000000000000000000000000004';
const ADDR5 = '0x0000000000000000000000000000000000000005';

const CHECKSUMED_ADDR = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const LOWER_CASE_ADDR = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';

describe('filler address repository test', () => {
  /*
   * filler1: [addr1, addr2]
   * filler2: [addr3]
   * filler3: [addr4, addr5]
   *
   */
  beforeAll(async () => {
    await repository.addNewAddressToFiller(ADDR1, 'filler1');
    await repository.addNewAddressToFiller(ADDR2, 'filler1');
    await repository.addNewAddressToFiller(ADDR3, 'filler2');
    await repository.addNewAddressToFiller(ADDR4, 'filler3');
    await repository.addNewAddressToFiller(ADDR5, 'filler3');
    await repository.addNewAddressToFiller(LOWER_CASE_ADDR, 'filler4');
  });

  it('should get filler addresses', async () => {
    const addresses = await repository.getFillerAddresses('filler1');
    expect(addresses).toEqual([ADDR1, ADDR2]);

    const addresses2 = await repository.getFillerAddresses('filler2');
    expect(addresses2).toEqual([ADDR3]);

    const addresses3 = await repository.getFillerAddresses('filler3');
    expect(addresses3).toEqual([ADDR4, ADDR5]);
  });

  it('should get filler by address', async () => {
    const filler = await repository.getFillerByAddress(ADDR1);
    expect(filler).toEqual('filler1');

    const filler2 = await repository.getFillerByAddress(ADDR2);
    expect(filler2).toEqual('filler1');

    const filler3 = await repository.getFillerByAddress(ADDR3);
    expect(filler3).toEqual('filler2');

    const filler4 = await repository.getFillerByAddress(ADDR4);
    expect(filler4).toEqual('filler3');

    const filler5 = await repository.getFillerByAddress(ADDR5);
    expect(filler5).toEqual('filler3');
  });

  it('should batch get filler to addresses map', async () => {
    const resMap = await repository.getFillerAddressesBatch(['filler1', 'filler2', 'filler3']);
    expect(resMap.size).toBe(3);
    expect(resMap.get('filler1')).toEqual(new Set([ADDR1, ADDR2]));
    expect(resMap.get('filler2')).toEqual(new Set([ADDR3]));
    expect(resMap.get('filler3')).toEqual(new Set([ADDR4, ADDR5]));
  });

  it('should get address to filler mapping', async () => {
    const res = await repository.getAddressToFillerMap(['filler1', 'filler2', 'filler3']);
    expect(res.size).toBe(5);
    expect(res.get(ADDR1)).toEqual('filler1');
    expect(res.get(ADDR2)).toEqual('filler1');
    expect(res.get(ADDR3)).toEqual('filler2');
    expect(res.get(ADDR4)).toEqual('filler3');
    expect(res.get(ADDR5)).toEqual('filler3');
  });

  it("if address already exists, doesn't modify state", async () => {
    await repository.addNewAddressToFiller(ADDR1, 'filler1');
    const addresses = await repository.getFillerAddresses('filler1');
    expect(addresses).toEqual([ADDR1, ADDR2]);
    const filler = await repository.getFillerByAddress(ADDR1);
    expect(filler).toEqual('filler1');
  });

  it('should checksum address when adding to db', async () => {
    expect(await repository.getFillerAddresses('filler4')).toEqual([CHECKSUMED_ADDR]);
  });
});
