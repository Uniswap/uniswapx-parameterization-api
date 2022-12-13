import { DocumentClient } from 'aws-sdk/clients/dynamodb';

import {DBQuoteRequest, DBQuoteResponse } from '../../lib/entities';
import { DynamoQuotesRepository } from '../../lib/repositories/ddb-quotes-repository';

const REQUEST_MOCKS: Record<string,DBQuoteRequest> = {};
const RESPONSE_MOCKS: Record<string, DBQuoteResponse> = {};

Array(3)
  .fill(0)
  .forEach((_, i) => {
    REQUEST_MOCKS[`${i}`] = {
      requestId: `requestId${i}`,
      type: `request#${i}`,
      tokenIn: `tokenIn${i}`,
      amountIn: `amountIn${i}`,
      tokenOut: `tokenOut${i}`,
      offerer: `offerer${i}`,
      createdAt: 1,
      deadline: 2,
    };
  });

Array(6)
  .fill(0)
  .forEach((_, i) => {
    RESPONSE_MOCKS[`${i}`] = {
      requestId: `requestId${Math.floor(i / 2)}`,
      type: `response#${i}`,
      id: `id${i}`,
      tokenIn: `tokenIn${Math.floor(i / 2)}`,
      amountIn: `amountIn${Math.floor(i / 2)}`,
      tokenOut: `tokenOut${i}`,
      offerer: `offerer${Math.floor(i / 2)}`,
      filler: `filler${i}`,
      amountOut: `amountOut${i}`,
      createdAt: 1,
      deadline: 2,
    };
  });

const dynamoConfig = {
  convertEmptyValues: true,
  endpoint: 'localhost:8000',
  region: 'local-env',
  sslEnabled: false,
  credentials: {
    accessKeyId: 'fakeMyKeyId',
    secretAccessKey: 'fakeSecretAccessKey',
  },
};

const documentClient = new DocumentClient(dynamoConfig);
const quotesRepository = DynamoQuotesRepository.create(documentClient);

describe('DynamoQuotesRepository tests', () => {
  describe('putRequest test', () => {
    it('should successfully put a quoteRequest in table', async () => {
      expect(() => quotesRepository.putRequest(REQUEST_MOCKS['0'])).not.toThrow();
    });
  });

  describe('getRequestById test', () => {
    it('should successfully get a quoteRequest by rid', async () => {
      const res = await quotesRepository.getRequestById(REQUEST_MOCKS['0'].requestId);
      expect(res).not.toBeNull();
      expect(res).toEqual(expect.objectContaining(REQUEST_MOCKS['0']));
    });

    it('should return null if requestId is not present in table', async () => {
      expect(await quotesRepository.getRequestById('foo')).toBeNull();
    });
  });

  describe('putResponses and getAllResponsesByRequestId tests', () => {
    it('should successfully put multiple requests in table', async () => {
      expect(async () => await quotesRepository.putResponses(Object.values(RESPONSE_MOCKS))).not.toThrow();
    });

    it('should successfully get all quoteResponses by rid', async () => {
      await quotesRepository.putResponses(Object.values(RESPONSE_MOCKS));
      const res = await quotesRepository.getAllResponsesByRequestId('requestId0');
      expect(res).not.toBeNull();
      expect(res).toHaveLength(2);
      expect(res).toMatchObject([RESPONSE_MOCKS['0'], RESPONSE_MOCKS['1']]);
    });

    it('should return an empty array if requestId is not present in table', async () => {
      expect(await quotesRepository.getAllResponsesByRequestId('foo')).toHaveLength(0);
    });
  });
});
