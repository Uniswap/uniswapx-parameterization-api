import { TradeType } from '@uniswap/sdk-core';
import { parseEther } from 'ethers/lib/utils';

import { QuoteResponse } from '../../lib/entities';

const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f7';
const SWAPPER = '0x0000000000000000000000000000000000000000';
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CHAIN_ID = 1;
const fixedTime = 4206969;
jest.spyOn(Date, 'now').mockImplementation(() => fixedTime);

describe('QuoteRequest', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const quoteResponse = new QuoteResponse(
    {
      chainId: CHAIN_ID,
      amountOut: parseEther('1'),
      amountIn: parseEther('1'),
      quoteId: QUOTE_ID,
      requestId: REQUEST_ID,
      swapper: SWAPPER,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
    },
    TradeType.EXACT_INPUT
  );
  const quoteRequest = {
    tokenInChainId: CHAIN_ID,
    tokenOutChainId: CHAIN_ID,
    requestId: REQUEST_ID,
    swapper: SWAPPER,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amount: parseEther('1'),
    type: TradeType.EXACT_INPUT,
    numOutputs: 1,
  };

  it('fromRequest', async () => {
    const response = QuoteResponse.fromRequest(quoteRequest, parseEther('1'));
    expect(response.createdAt).toBe(quoteResponse.createdAt);
    expect(response.amountIn).toEqual(quoteResponse.amountIn);
    expect(response.amountOut).toEqual(quoteResponse.amountOut);
    expect(response.requestId).toBe(quoteResponse.requestId);
    expect(response.swapper).toBe(quoteResponse.swapper);
    expect(response.tokenIn).toBe(quoteResponse.tokenIn);
    expect(response.tokenOut).toBe(quoteResponse.tokenOut);
  });

  describe('fromRFQ', () => {
    it('fromRFQ with valid response', async () => {
      const response = QuoteResponse.fromRFQ(
        quoteRequest,
        {
          chainId: CHAIN_ID,
          requestId: REQUEST_ID,
          tokenIn: TOKEN_IN,
          amountIn: parseEther('1').toString(),
          tokenOut: TOKEN_OUT,
          amountOut: parseEther('1').toString(),
          quoteId: QUOTE_ID,
        },
        TradeType.EXACT_INPUT
      );
      expect(response.response).toEqual(quoteResponse);
      expect(response.validationError).toBe(undefined);
    });

    it('fromRFQ with valid response - allow checksumed', async () => {
      const response = QuoteResponse.fromRFQ(
        quoteRequest,
        {
          chainId: CHAIN_ID,
          requestId: REQUEST_ID,
          tokenIn: TOKEN_IN.toLowerCase(),
          amountIn: parseEther('1').toString(),
          tokenOut: TOKEN_OUT.toLowerCase(),
          amountOut: parseEther('1').toString(),
          quoteId: QUOTE_ID,
        },
        TradeType.EXACT_INPUT
      );
      expect(response.validationError).toBe(undefined);
    });

    it('fromRFQ with invalid response - wrong type amountIn', async () => {
      const invalidResponse = {
        chainId: CHAIN_ID,
        requestId: REQUEST_ID,
        tokenIn: TOKEN_IN,
        amountIn: 100 as any,
        tokenOut: TOKEN_OUT,
        amountOut: parseEther('1').toString(),
        quoteId: QUOTE_ID,
      };
      const response = QuoteResponse.fromRFQ(quoteRequest, invalidResponse, TradeType.EXACT_INPUT);
      // ensure we overwrite amount with the request amount, dont just accept what the quoter returned
      expect(response.response.amountIn).toEqual(quoteRequest.amount);
      expect(response.validationError?.message).toBe('"amountIn" must be a string');
      expect(response.validationError?.value).toBe(invalidResponse);
    });

    it('fromRFQ with invalid response - mismatched tokenIn', async () => {
      const invalidResponse = {
        chainId: CHAIN_ID,
        requestId: REQUEST_ID,
        tokenIn: '0x0000000000000000000000000000000000000000',
        amountIn: parseEther('1').toString(),
        tokenOut: TOKEN_OUT,
        amountOut: parseEther('1').toString(),
        quoteId: QUOTE_ID,
      };
      const response = QuoteResponse.fromRFQ(quoteRequest, invalidResponse, TradeType.EXACT_INPUT);
      expect(response.response.tokenIn).toEqual('0x0000000000000000000000000000000000000000');
      expect(response.validationError?.message).toBe(
        'RFQ response token mismatch: request tokenIn: 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984 tokenOut: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 response tokenIn: 0x0000000000000000000000000000000000000000 tokenOut: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
      );
      expect(response.validationError?.value).toBe(invalidResponse);
    });

    it('fromRFQ with invalid response - mismatched tokenOut', async () => {
      const invalidResponse = {
        chainId: CHAIN_ID,
        requestId: REQUEST_ID,
        tokenIn: TOKEN_IN,
        amountIn: parseEther('1').toString(),
        tokenOut: '0x0000000000000000000000000000000000000000',
        amountOut: parseEther('1').toString(),
        quoteId: QUOTE_ID,
      };
      const response = QuoteResponse.fromRFQ(quoteRequest, invalidResponse, TradeType.EXACT_INPUT);
      expect(response.response.tokenOut).toEqual('0x0000000000000000000000000000000000000000');
      expect(response.validationError?.message).toBe(
        'RFQ response token mismatch: request tokenIn: 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984 tokenOut: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 response tokenIn: 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984 tokenOut: 0x0000000000000000000000000000000000000000'
      );
      expect(response.validationError?.value).toBe(invalidResponse);
    });
  });

  it('toResponseJSON', async () => {
    expect(quoteResponse.toResponseJSON()).toEqual({
      chainId: CHAIN_ID,
      amountOut: parseEther('1').toString(),
      amountIn: parseEther('1').toString(),
      quoteId: QUOTE_ID,
      requestId: REQUEST_ID,
      swapper: SWAPPER,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      filler: undefined,
    });
  });

  it('toLog', async () => {
    expect(quoteResponse.toLog()).toEqual({
      createdAt: expect.any(String),
      createdAtMs: expect.any(String),
      amountOut: parseEther('1').toString(),
      amountIn: parseEther('1').toString(),
      quoteId: QUOTE_ID,
      requestId: REQUEST_ID,
      swapper: SWAPPER,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      filler: undefined,
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
    });
  });
});
