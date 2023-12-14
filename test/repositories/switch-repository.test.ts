/* eslint-disable @typescript-eslint/ban-ts-comment */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { SynthSwitchQueryParams } from '../../lib/handlers/synth-switch';
import { SwitchRepository } from '../../lib/repositories/switch-repository';
import { DYNAMO_CONFIG } from './shared';

const SWITCH: SynthSwitchQueryParams = {
  tokenIn: 'USDC',
  tokenOut: 'UNI',
  tokenInChainId: 1,
  tokenOutChainId: 1,
  amount: '10000000000',
  type: 'EXACT_INPUT',
};

const NONEXISTENT_SWITCH: SynthSwitchQueryParams = {
  tokenIn: 'USDC',
  tokenOut: 'UNI',
  tokenInChainId: 1,
  tokenOutChainId: 1,
  amount: '1000000000000000000',
  type: 'EXACT_OUTPUT',
};

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(DYNAMO_CONFIG), {
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

  it('should not return true if amount is not greater than lower', async () => {
    await switchRepository.putSynthSwitch(SWITCH, '1000000000000000000', true);

    const enabled = await switchRepository.syntheticQuoteForTradeEnabled(SWITCH);
    expect(enabled).toBe(false);
  });

  it('should return false for non-existent switch', async () => {
    await expect(switchRepository.syntheticQuoteForTradeEnabled(NONEXISTENT_SWITCH)).resolves.toBe(false);
  });
});

describe('static helper function tests', () => {
  it('correctly serializes key from trade', () => {
    expect(SwitchRepository.getKey(SWITCH)).toBe('usdc#1#uni#1#EXACT_INPUT');
  });

  it('should throw error for invalid key on parse', () => {
    expect(() => {
      // missing type
      SwitchRepository.parseKey('token0#1#token1#1');
    }).toThrowError('Invalid key: token0#1#token1#1');
  });
});
