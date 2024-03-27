import { TradeType } from '@uniswap/sdk-core';
import { UnsignedV2DutchOrder, UnsignedV2DutchOrderInfo } from '@uniswap/uniswapx-sdk';
import { BigNumber, ethers } from 'ethers';

import { HardQuoteRequest } from '../../lib/entities';
import { HardQuoteRequestBody } from '../../lib/handlers/hard-quote';

const NOW = Math.floor(new Date().getTime() / 1000);
const RAW_AMOUNT = BigNumber.from('1000000');
const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const SWAPPER = '0x0000000000000000000000000000000000000000';
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CHAIN_ID = 1;

export const getOrderInfo = (data: Partial<UnsignedV2DutchOrderInfo>): UnsignedV2DutchOrderInfo => {
  return Object.assign(
    {
      deadline: NOW + 1000,
      reactor: ethers.constants.AddressZero,
      swapper: ethers.constants.AddressZero,
      nonce: BigNumber.from(10),
      additionalValidationContract: ethers.constants.AddressZero,
      additionalValidationData: '0x',
      cosigner: ethers.constants.AddressZero,
      input: {
        token: TOKEN_IN,
        startAmount: RAW_AMOUNT,
        endAmount: RAW_AMOUNT,
      },
      outputs: [
        {
          token: TOKEN_OUT,
          startAmount: RAW_AMOUNT.mul(2),
          endAmount: RAW_AMOUNT.mul(90).div(100),
          recipient: ethers.constants.AddressZero,
        },
      ],
    },
    data
  );
};

const makeRequest = (data: Partial<HardQuoteRequestBody>): HardQuoteRequest => {
  return new HardQuoteRequest(
    Object.assign(
      {
        requestId: REQUEST_ID,
        quoteId: QUOTE_ID,
        tokenInChainId: CHAIN_ID,
        tokenOutChainId: CHAIN_ID,
        encodedInnerOrder: '0x',
        innerSig: '0x',
      },
      data
    )
  );
};

describe('QuoteRequest', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('parses order properly', () => {
    const order = new UnsignedV2DutchOrder(
      getOrderInfo({
        swapper: SWAPPER,
      }),
      CHAIN_ID
    );
    const request = makeRequest({ encodedInnerOrder: order.serialize(), innerSig: '0x' });
    expect(request.swapper).toEqual(SWAPPER);
    expect(request.tokenIn).toEqual(TOKEN_IN);
    expect(request.tokenOut).toEqual(TOKEN_OUT);
    expect(request.numOutputs).toEqual(1);
    expect(request.amount).toEqual(RAW_AMOUNT);
    expect(request.type).toEqual(TradeType.EXACT_INPUT);
  });

  it('toCleanJSON', async () => {
    const order = new UnsignedV2DutchOrder(
      getOrderInfo({
        swapper: SWAPPER,
      }),
      CHAIN_ID
    );
    const request = makeRequest({ encodedInnerOrder: order.serialize(), innerSig: '0x' });
    expect(request.toCleanJSON()).toEqual({
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      requestId: REQUEST_ID,
      quoteId: QUOTE_ID,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amount: RAW_AMOUNT.toString(),
      swapper: ethers.constants.AddressZero,
      type: 'EXACT_INPUT',
      numOutputs: 1,
    });
  });

  it('toOpposingCleanJSON', async () => {
    const order = new UnsignedV2DutchOrder(
      getOrderInfo({
        swapper: SWAPPER,
      }),
      CHAIN_ID
    );
    const request = makeRequest({ encodedInnerOrder: order.serialize(), innerSig: '0x' });
    expect(request.toOpposingCleanJSON()).toEqual({
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      requestId: REQUEST_ID,
      quoteId: QUOTE_ID,
      tokenIn: TOKEN_OUT,
      tokenOut: TOKEN_IN,
      amount: RAW_AMOUNT.toString(),
      swapper: ethers.constants.AddressZero,
      type: 'EXACT_OUTPUT',
      numOutputs: 1,
    });
  });
});
