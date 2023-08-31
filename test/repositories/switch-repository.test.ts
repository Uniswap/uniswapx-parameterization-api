/* eslint-disable @typescript-eslint/ban-ts-comment */

import { DynamoDBClient, DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { SynthSwitchQueryParams } from '../../lib/handlers/synth-switch';
import { SwitchRepository } from '../../lib/repositories/switch-repository';

const dynamoConfig: DynamoDBClientConfig = {
  endpoint: 'http://localhost:8000',
  region: 'local',
  credentials: {
    accessKeyId: 'fakeMyKeyId',
    secretAccessKey: 'fakeSecretAccessKey',
  },
};

const SWITCH: SynthSwitchQueryParams = {
  inputToken: 'USDC',
  outputToken: 'UNI',
  inputTokenChainId: 1,
  outputTokenChainId: 1,
  amount: '10000000000',
  type: 'EXACT_INPUT',
};

const NONEXISTENT_SWITCH: SynthSwitchQueryParams = {
  inputToken: 'USDC',
  outputToken: 'UNI',
  inputTokenChainId: 1,
  outputTokenChainId: 1,
  amount: '1000000000000000000',
  type: 'EXACT_OUTPUT',
};

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(dynamoConfig), {
  marshallOptions: {
    convertEmptyValues: true,
  },
  unmarshallOptions: {
    wrapNumbers: true,
  },
});

const switchRepository = SwitchRepository.create(documentClient);

describe('put switch tests', () => {
  it('should put synth switch into db and overwrites previous one if exists', async () => {
    await expect(switchRepository.putSynthSwitch(SWITCH, '10000', true)).resolves.not.toThrow();

    let enabled = await switchRepository.syntheticQuoteForTradeEnabled(SWITCH);
    expect(enabled).toBe(true);

    await switchRepository.putSynthSwitch(SWITCH, '1000000000', false);

    enabled = await switchRepository.syntheticQuoteForTradeEnabled(SWITCH);
    expect(enabled).toBe(false);
  });

  it('should return false for non-existent switch', async () => {
    await expect(switchRepository.syntheticQuoteForTradeEnabled(NONEXISTENT_SWITCH)).resolves.toBe(false);
  });
});

describe('static helper function tests', () => {
  it('should throw error for invalid key on parse', () => {
    expect(() => {
      // missing type
      SwitchRepository.parseKey('token0#1#token1#1');
    }).toThrowError('Invalid key: token0#1#token1#1');
  })
})
