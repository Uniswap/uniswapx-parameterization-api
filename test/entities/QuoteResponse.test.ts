import { TradeType } from '@uniswap/sdk-core';
import { parseEther } from 'ethers/lib/utils';
import { ethers } from 'ethers';

import { QuoteResponse } from '../../lib/entities';
import { ProtocolVersion } from '../../lib/providers';
import { PermissionedTokenValidator } from '@uniswap/uniswapx-sdk';
import { RFQValidator } from '../../lib/util/rfqValidator';

const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f7';
const SWAPPER = '0x0000000000000000000000000000000000000000';
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CHAIN_ID = 1;
const fixedTime = 4206969;
const WEBHOOK_URL = 'https://uniswap.org';
const METADATA = {
  endpoint: WEBHOOK_URL,
  fillerName: 'uniswap',
};

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
    TradeType.EXACT_INPUT,
    METADATA
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
    protocol: ProtocolVersion.V1,
  };

  it('fromRequest', async () => {
    const response = QuoteResponse.fromRequest({
      request: quoteRequest,
      amountQuoted: parseEther('1'),
      metadata: METADATA,
    });
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
      const response = QuoteResponse.fromRFQ({
        request: quoteRequest,
        data: {
          chainId: CHAIN_ID,
          requestId: REQUEST_ID,
          tokenIn: TOKEN_IN,
          amountIn: parseEther('1').toString(),
          tokenOut: TOKEN_OUT,
          amountOut: parseEther('1').toString(),
          quoteId: QUOTE_ID,
        },
        type: TradeType.EXACT_INPUT,
        metadata: METADATA,
      });
      expect(response.response).toEqual(quoteResponse);
      expect(response.validationError).toBe(undefined);
    });

    it('fromRFQ with valid response - allow checksumed', async () => {
      const response = QuoteResponse.fromRFQ({
        request: quoteRequest,
        data: {
          chainId: CHAIN_ID,
          requestId: REQUEST_ID,
          tokenIn: TOKEN_IN.toLowerCase(),
          amountIn: parseEther('1').toString(),
          tokenOut: TOKEN_OUT.toLowerCase(),
          amountOut: parseEther('1').toString(),
          quoteId: QUOTE_ID,
        },
        type: TradeType.EXACT_INPUT,
        metadata: METADATA,
      });
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
      const response = QuoteResponse.fromRFQ({
        request: quoteRequest,
        data: invalidResponse,
        type: TradeType.EXACT_INPUT,
        metadata: METADATA,
      });
      // ensure we overwrite amount with the request amount, dont just accept what the quoter returned
      expect(response.response.amountIn).toEqual(quoteRequest.amount);
      expect(response.validationError?.message).toContain('"amountIn" must be a string');
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
      const response = QuoteResponse.fromRFQ({
        request: quoteRequest,
        data: invalidResponse,
        type: TradeType.EXACT_INPUT,
        metadata: METADATA,
      });
      expect(response.response.tokenIn).toEqual('0x0000000000000000000000000000000000000000');
      expect(response.validationError?.message).toContain(
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
      const response = QuoteResponse.fromRFQ({
        request: quoteRequest,
        data: invalidResponse,
        type: TradeType.EXACT_INPUT,
        metadata: METADATA,
      });
      expect(response.response.tokenOut).toEqual('0x0000000000000000000000000000000000000000');
      expect(response.validationError?.message).toContain(
        'RFQ response token mismatch: request tokenIn: 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984 tokenOut: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 response tokenIn: 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984 tokenOut: 0x0000000000000000000000000000000000000000'
      );
      expect(response.validationError?.value).toBe(invalidResponse);
    });

    it('fromRFQ with permissioned tokenIn - no provider', async () => {
      jest.spyOn(PermissionedTokenValidator, 'isPermissionedToken')
        .mockImplementation((token) => token === TOKEN_IN);
      
      const response = QuoteResponse.fromRFQ({
        request: quoteRequest,
        data: {
          chainId: CHAIN_ID,
          requestId: REQUEST_ID,
          tokenIn: TOKEN_IN,
          amountIn: quoteRequest.amount.toString(),
          tokenOut: TOKEN_OUT,
          amountOut: parseEther('1').toString(),
          quoteId: QUOTE_ID,
          filler: '0x1234567890123456789012345678901234567890',
        },
        type: TradeType.EXACT_INPUT,
        metadata: METADATA,
      });

      const validationError = await RFQValidator.validatePermissionedTokens(
        quoteRequest,
        response.response.toResponseJSON(),
        quoteRequest.amount,
        response.response.amountOut
      );

      expect(validationError).toContain(
        `provider is required for permissioned token check for token: ${TOKEN_IN} on chain: ${CHAIN_ID}`
      );
    });

    it('fromRFQ with no permissioned tokens - no provider', async () => {
      jest.spyOn(PermissionedTokenValidator, 'isPermissionedToken').mockReturnValue(false);
      const preTransferCheckMock = jest.spyOn(PermissionedTokenValidator, 'preTransferCheck')
        .mockResolvedValue(true);
      
      const response = QuoteResponse.fromRFQ({
        request: quoteRequest,
        data: {
          chainId: CHAIN_ID,
          requestId: REQUEST_ID,
          tokenIn: TOKEN_IN,
          amountIn: quoteRequest.amount.toString(),
          tokenOut: TOKEN_OUT,
          amountOut: parseEther('1').toString(),
          quoteId: QUOTE_ID,
          filler: '0x1234567890123456789012345678901234567890',
        },
        type: TradeType.EXACT_INPUT,
        metadata: METADATA,
      });

      const validationError = await RFQValidator.validatePermissionedTokens(
        quoteRequest,
        response.response.toResponseJSON(),
        quoteRequest.amount,
        response.response.amountOut
      );

      expect(validationError).toBe(undefined);
      expect(preTransferCheckMock).toHaveBeenCalledTimes(0);
    });

    it('fromRFQ with permissioned tokenOut - no provider', async () => {
      jest.spyOn(PermissionedTokenValidator, 'isPermissionedToken')
        .mockImplementation((token) => token === TOKEN_OUT);
      
      const response = QuoteResponse.fromRFQ({
        request: quoteRequest,
        data: {
          chainId: CHAIN_ID,
          requestId: REQUEST_ID,
          tokenIn: TOKEN_IN,
          amountIn: quoteRequest.amount.toString(),
          tokenOut: TOKEN_OUT,
          amountOut: parseEther('1').toString(),
          quoteId: QUOTE_ID,
          filler: '0x1234567890123456789012345678901234567890',
        },
        type: TradeType.EXACT_INPUT,
        metadata: METADATA,
      });

      const validationError = await RFQValidator.validatePermissionedTokens(
        quoteRequest,
        response.response.toResponseJSON(),
        quoteRequest.amount,
        response.response.amountOut
      );

      expect(validationError).toContain(
        `provider is required for permissioned token check for token: ${TOKEN_OUT} on chain: ${CHAIN_ID}`
      );
    });

    it('fromRFQ with permissioned tokenIn - failed preTransferCheck', async () => {
      const mockProvider = {} as ethers.providers.StaticJsonRpcProvider;
      const filler = '0x1234567890123456789012345678901234567890';
      
      jest.spyOn(PermissionedTokenValidator, 'isPermissionedToken')
        .mockImplementation((token) => token === TOKEN_IN);
      jest.spyOn(PermissionedTokenValidator, 'preTransferCheck')
        .mockResolvedValue(false);

      const response = QuoteResponse.fromRFQ({
        request: quoteRequest,
        data: {
          chainId: CHAIN_ID,
          requestId: REQUEST_ID,
          tokenIn: TOKEN_IN,
          amountIn: quoteRequest.amount.toString(),
          tokenOut: TOKEN_OUT,
          amountOut: parseEther('1').toString(),
          quoteId: QUOTE_ID,
          filler,
        },
        type: TradeType.EXACT_INPUT,
        metadata: METADATA,
      });

      const validationError = await RFQValidator.validatePermissionedTokens(
        quoteRequest,
        response.response.toResponseJSON(),
        quoteRequest.amount,
        response.response.amountOut,
        mockProvider
      );

      expect(validationError).toContain(
        `preTransferCheck check failed for token: ${TOKEN_IN} from ${SWAPPER} to ${filler}`
      );
    });

    it('fromRFQ with permissioned tokenOut - failed preTransferCheck', async () => {
      const mockProvider = {} as ethers.providers.StaticJsonRpcProvider;
      const filler = '0x1234567890123456789012345678901234567890';
      
      jest.spyOn(PermissionedTokenValidator, 'isPermissionedToken')
        .mockImplementation((token) => token === TOKEN_OUT);
      jest.spyOn(PermissionedTokenValidator, 'preTransferCheck')
        .mockResolvedValue(false);

      const response = QuoteResponse.fromRFQ({
        request: quoteRequest,
        data: {
          chainId: CHAIN_ID,
          requestId: REQUEST_ID,
          tokenIn: TOKEN_IN,
          amountIn: quoteRequest.amount.toString(),
          tokenOut: TOKEN_OUT,
          amountOut: parseEther('1').toString(),
          quoteId: QUOTE_ID,
          filler,
        },
        type: TradeType.EXACT_INPUT,
        metadata: METADATA,
      });

      const validationError = await RFQValidator.validatePermissionedTokens(
        quoteRequest,
        response.response.toResponseJSON(),
        quoteRequest.amount,
        response.response.amountOut,
        mockProvider
      );

      expect(validationError).toContain(
        `preTransferCheck check failed for token: ${TOKEN_OUT} from ${filler} to ${SWAPPER}`
      );
    });

    it('fromRFQ with permissioned tokens - successful preTransferCheck', async () => {
      const mockProvider = {} as ethers.providers.StaticJsonRpcProvider;
      const filler = '0x1234567890123456789012345678901234567890';
      const amountIn = quoteRequest.amount;
      const amountOut = parseEther('1.5');
      
      const preTransferCheckMock = jest.spyOn(PermissionedTokenValidator, 'preTransferCheck')
        .mockResolvedValue(true);
      jest.spyOn(PermissionedTokenValidator, 'isPermissionedToken').mockReturnValue(true);

      const response = QuoteResponse.fromRFQ({
        request: quoteRequest,
        data: {
          chainId: CHAIN_ID,
          requestId: REQUEST_ID,
          tokenIn: TOKEN_IN,
          amountIn: amountIn.toString(),
          tokenOut: TOKEN_OUT,
          amountOut: amountOut.toString(),
          quoteId: QUOTE_ID,
          filler,
        },
        type: TradeType.EXACT_INPUT,
        metadata: METADATA,
      });

      const validationError = await RFQValidator.validatePermissionedTokens(
        quoteRequest,
        response.response.toResponseJSON(),
        quoteRequest.amount,
        response.response.amountOut,
        mockProvider
      );

      expect(validationError).toBe(undefined);
      expect(preTransferCheckMock).toHaveBeenCalledTimes(2);
      expect(preTransferCheckMock).toHaveBeenNthCalledWith(1,
        mockProvider,
        TOKEN_IN,
        SWAPPER,
        filler,
        amountIn.toString()
      );
      expect(preTransferCheckMock).toHaveBeenNthCalledWith(2,
        mockProvider,
        TOKEN_OUT,
        filler,
        SWAPPER,
        amountOut.toString()
      );
    });

    it('fromRFQ with permissioned tokens - preTransferCheck throws error', async () => {
      const mockProvider = {} as ethers.providers.StaticJsonRpcProvider;
      const filler = '0x1234567890123456789012345678901234567890';
      const mockLogger = { error: jest.fn() } as any;
      
      jest.spyOn(PermissionedTokenValidator, 'isPermissionedToken').mockReturnValue(true);
      jest.spyOn(PermissionedTokenValidator, 'preTransferCheck').mockImplementation(() => {
        throw new Error('Simulated preTransferCheck error');
      });

      const response = QuoteResponse.fromRFQ({
        request: quoteRequest,
        data: {
          chainId: CHAIN_ID,
          requestId: REQUEST_ID,
          tokenIn: TOKEN_IN,
          amountIn: parseEther('1').toString(),
          tokenOut: TOKEN_OUT,
          amountOut: parseEther('1').toString(),
          quoteId: QUOTE_ID,
          filler,
        },
        type: TradeType.EXACT_INPUT,
        metadata: METADATA,
      });

      const validationError = await RFQValidator.validatePermissionedTokens(
        quoteRequest,
        response.response.toResponseJSON(),
        quoteRequest.amount,
        response.response.amountOut,
        mockProvider,
        mockLogger
      );

      expect(validationError).toBe(undefined);
      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: new Error('Simulated preTransferCheck error') },
        'error checking permissioned tokens'
      );
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
