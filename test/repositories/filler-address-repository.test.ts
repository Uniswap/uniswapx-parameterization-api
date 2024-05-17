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

describe('filler address repository test', () => {
  /*
   * filler1: [addr1, addr2]
   * filler2: [addr3]
   * filler3: [addr4, addr5]
   *
   */
  beforeAll(async () => {
    await repository.addNewAddressToFiller('addr1', 'filler1');
    await repository.addNewAddressToFiller('addr2', 'filler1');
    await repository.addNewAddressToFiller('addr3', 'filler2');
    await repository.addNewAddressToFiller('addr4', 'filler3');
    await repository.addNewAddressToFiller('addr5', 'filler3');
  });

  it('should get filler addresses', async () => {
    const addresses = await repository.getFillerAddresses('filler1');
    expect(addresses).toEqual(['addr1', 'addr2']);

    const addresses2 = await repository.getFillerAddresses('filler2');
    expect(addresses2).toEqual(['addr3']);

    const addresses3 = await repository.getFillerAddresses('filler3');
    expect(addresses3).toEqual(['addr4', 'addr5']);
  });

  it('should get filler by address', async () => {
    const filler = await repository.getFillerByAddress('addr1');
    expect(filler).toEqual('filler1');

    const filler2 = await repository.getFillerByAddress('addr2');
    expect(filler2).toEqual('filler1');

    const filler3 = await repository.getFillerByAddress('addr3');
    expect(filler3).toEqual('filler2');

    const filler4 = await repository.getFillerByAddress('addr4');
    expect(filler4).toEqual('filler3');

    const filler5 = await repository.getFillerByAddress('addr5');
    expect(filler5).toEqual('filler3');
  });

  it('should batch get filler to addresses map', async () => {
    const resMap = await repository.getFillerAddressesBatch(['filler1', 'filler2', 'filler3']);
    expect(resMap.size).toBe(3);
    expect(resMap.get('filler1')).toEqual(['addr1', 'addr2']);
    expect(resMap.get('filler2')).toEqual(['addr3']);
    expect(resMap.get('filler3')).toEqual(['addr4', 'addr5']);
  });

  it("if address already exists, doesn't modify state", async () => {
    await repository.addNewAddressToFiller('addr1', 'filler1');
    const addresses = await repository.getFillerAddresses('filler1');
    expect(addresses).toEqual(['addr1', 'addr2']);
    const filler = await repository.getFillerByAddress('addr1');
    expect(filler).toEqual('filler1');
  });
});
