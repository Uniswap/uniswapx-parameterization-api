/* eslint-disable @typescript-eslint/ban-ts-comment */

import { DynamoDBClient, DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { SynthSwitchRequestBody } from '../../lib/handlers/synth-switch';
import { SwitchRepository } from '../../lib/repositories/switch-repository';

const dynamoConfig: DynamoDBClientConfig = {
  endpoint: 'http://localhost:8000',
  region: 'local',
  credentials: {
    accessKeyId: 'fakeMyKeyId',
    secretAccessKey: 'fakeSecretAccessKey',
  },
};

const SWITCH: SynthSwitchRequestBody = {
  inputToken: 'USDC',
  outputToken: 'UNI',
  inputTokenChainId: 1,
  outputTokenChainId: 1,
  amount: '1000000000000000000',
  type: 'EXACT_INPUT',
};

const NONEXISTENT_SWITCH: SynthSwitchRequestBody = {
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
  it('should put synth switch into db', async () => {
    expect(() => {
      switchRepository.putSynthSwitch(SWITCH, '10000000000', true);
    }).not.toThrow();

    const enabled = await switchRepository.syntheticQuoteForTradeEnabled(SWITCH);
    expect(enabled).toBe(true);
  });

  it('should return false for non-existent switch', async () => {
    await expect(switchRepository.syntheticQuoteForTradeEnabled(NONEXISTENT_SWITCH)).resolves.toBe(false);
  });
});
