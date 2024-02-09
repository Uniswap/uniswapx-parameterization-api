import { TradeType } from '@uniswap/sdk-core';
import { ethers } from 'ethers';

import { QuoteRequest } from '../../lib/entities';

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
    });
  });
});
