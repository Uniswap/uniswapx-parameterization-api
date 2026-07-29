import { TradeType } from '@uniswap/sdk-core';
import { ethers } from 'ethers';

import { QuoteRequest } from '../../lib/entities';
import { ProtocolVersion } from '../../lib/providers';

const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const SWAPPER = '0x0000000000000000000000000000000000000000';
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CHAIN_ID = 1;

describe('QuoteRequest', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const request = new QuoteRequest({
    tokenInChainId: CHAIN_ID,
    tokenOutChainId: CHAIN_ID,
    requestId: REQUEST_ID,
    swapper: SWAPPER,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amount: ethers.utils.parseEther('1'),
    type: TradeType.EXACT_INPUT,
    numOutputs: 1,
    protocol: ProtocolVersion.V1,
  });

  it('toCleanJSON', async () => {
    expect(request.toCleanJSON()).toEqual({
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      requestId: REQUEST_ID,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amount: ethers.utils.parseEther('1').toString(),
      swapper: ethers.constants.AddressZero,
      type: 'EXACT_INPUT',
      numOutputs: 1,
      protocol: ProtocolVersion.V1,
    });
  });

  it('toOpposingCleanJSON', async () => {
    expect(request.toOpposingCleanJSON()).toEqual({
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      requestId: REQUEST_ID,
      tokenIn: TOKEN_OUT,
      tokenOut: TOKEN_IN,
      amount: ethers.utils.parseEther('1').toString(),
      swapper: ethers.constants.AddressZero,
      type: 'EXACT_OUTPUT',
      numOutputs: 1,
      protocol: ProtocolVersion.V1,
    });
  });

  it('toOpposingRequest', async () => {
    const opposingRequest = request.toOpposingRequest();
    expect(opposingRequest.toCleanJSON()).toEqual({
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      requestId: REQUEST_ID,
      tokenIn: TOKEN_OUT,
      tokenOut: TOKEN_IN,
      amount: ethers.utils.parseEther('1').toString(),
      swapper: SWAPPER,
      type: 'EXACT_OUTPUT',
      numOutputs: 1,
      protocol: ProtocolVersion.V1,
    });
  });

  // Every other fixture here sets the two chain ids equal, which cannot tell a correct
  // tokenOutChainId getter apart from one returning tokenInChainId. These construct the entity
  // directly because the API cannot produce differing ids today — PostQuoteRequestBodyJoi pins
  // tokenOutChainId to Joi.ref('tokenInChainId').
  describe('with distinct tokenIn/tokenOut chain ids', () => {
    const OTHER_CHAIN_ID = 42161;

    const crossChainRequest = new QuoteRequest({
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: OTHER_CHAIN_ID,
      requestId: REQUEST_ID,
      swapper: SWAPPER,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amount: ethers.utils.parseEther('1'),
      type: TradeType.EXACT_INPUT,
      numOutputs: 1,
      protocol: ProtocolVersion.V1,
    });

    it('reads each chain id from its own field', () => {
      expect(crossChainRequest.tokenInChainId).toEqual(CHAIN_ID);
      expect(crossChainRequest.tokenOutChainId).toEqual(OTHER_CHAIN_ID);
    });

    it('carries both chain ids through toCleanJSON', () => {
      const json = crossChainRequest.toCleanJSON();
      expect(json.tokenInChainId).toEqual(CHAIN_ID);
      expect(json.tokenOutChainId).toEqual(OTHER_CHAIN_ID);
    });

    it('swaps the chain ids for the opposing side', () => {
      const opposing = crossChainRequest.toOpposingCleanJSON();
      expect(opposing.tokenInChainId).toEqual(OTHER_CHAIN_ID);
      expect(opposing.tokenOutChainId).toEqual(CHAIN_ID);
    });
  });
});
