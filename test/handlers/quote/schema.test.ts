import { ethers } from 'ethers';
import { v4 as uuidv4 } from 'uuid';

import { PostQuoteRequestBodyJoi, PostQuoteResponseJoi, RfqResponseJoi } from '../../../lib/handlers/quote/schema';

const OFFERER = '0x0000000000000000000000000000000000000000';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const REQUEST_ID = uuidv4();

const validTokenIn = [USDC, WETH].reduce(lowerUpper, []);
const validTokenOut = [USDC, WETH].reduce(lowerUpper, []);
const validAmountIn = [
  '1',
  '1000',
  '1234234',
  ethers.utils.parseEther('1').toString(),
  ethers.utils.parseEther('100000').toString(),
];
const validCombinations = validTokenIn.flatMap((tokenIn) =>
  validTokenOut.flatMap((tokenOut) =>
    validAmountIn.flatMap((amount) => ({
      requestId: REQUEST_ID,
      tokenInChainId: 1,
      tokenOutChainId: 1,
      offerer: OFFERER,
      tokenIn,
      tokenOut,
      amount: amount,
      type: 'EXACT_INPUT',
    }))
  )
);

describe('Schema tests', () => {
  describe('PostQuoteRequestBodyJoi', () => {
    it('validates valid inputs', () => {
      for (const body of validCombinations) {
        const validated = PostQuoteRequestBodyJoi.validate(body);
        expect(validated.error).toBeUndefined();
        expect(validated.value).toStrictEqual({
          requestId: REQUEST_ID,
          tokenInChainId: 1,
          tokenOutChainId: 1,
          tokenIn: ethers.utils.getAddress(body.tokenIn),
          tokenOut: ethers.utils.getAddress(body.tokenOut),
          amount: body.amount,
          offerer: OFFERER,
          type: 'EXACT_INPUT',
        });
      }
    });

    it('adds missing 0x prefix', () => {
      let validated = PostQuoteRequestBodyJoi.validate(
        Object.assign({}, validCombinations[0], {
          tokenIn: 'A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        })
      );
      expect(validated.error?.message).toBeUndefined();
      expect(validated.value.tokenIn).toEqual('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');

      validated = PostQuoteRequestBodyJoi.validate(
        Object.assign({}, validCombinations[0], {
          tokenOut: 'A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        })
      );
      expect(validated.error?.message).toBeUndefined();
      expect(validated.value.tokenOut).toEqual('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    });

    it('requires correct address length', () => {
      let validated = PostQuoteRequestBodyJoi.validate(
        Object.assign({}, validCombinations[0], {
          tokenIn: '0x1234',
        })
      );
      expect(validated.error?.message).toMatch('Invalid address');

      validated = PostQuoteRequestBodyJoi.validate(
        Object.assign({}, validCombinations[0], {
          tokenIn: '0x123412341234123412341324132412341324132412341324134',
        })
      );
      expect(validated.error?.message).toMatch('Invalid address');
    });

    it('requires amount to be a string number', () => {
      let validated = PostQuoteRequestBodyJoi.validate(
        Object.assign({}, validCombinations[0], {
          amount: 'abcd',
        })
      );
      expect(validated.error?.message).toMatch('Invalid amount');

      validated = PostQuoteRequestBodyJoi.validate(
        Object.assign({}, validCombinations[0], {
          amount: '1234*',
        })
      );
      expect(validated.error?.message).toMatch('Invalid amount');
    });

    it('requires tokenIn to be defined', () => {
      const { tokenOut, amount, offerer, tokenInChainId, tokenOutChainId, requestId } = validCombinations[0];
      const validated = PostQuoteRequestBodyJoi.validate({
        tokenOut,
        amount,
        offerer,
        tokenInChainId,
        tokenOutChainId,
        requestId,
      });
      expect(validated.error?.message).toEqual('"tokenIn" is required');
    });

    it('requires tokenOut to be defined', () => {
      const { tokenIn, amount, offerer, tokenInChainId, tokenOutChainId, requestId } = validCombinations[0];
      const validated = PostQuoteRequestBodyJoi.validate({
        tokenIn,
        amount,
        offerer,
        tokenInChainId,
        tokenOutChainId,
        requestId,
      });
      expect(validated.error?.message).toEqual('"tokenOut" is required');
    });

    it('requires amount to be defined', () => {
      const { tokenIn, tokenOut, offerer, tokenInChainId, tokenOutChainId, requestId } = validCombinations[0];
      const validated = PostQuoteRequestBodyJoi.validate({
        tokenIn,
        tokenOut,
        offerer,
        tokenInChainId,
        tokenOutChainId,
        requestId,
      });
      expect(validated.error?.message).toEqual('"amount" is required');
    });

    it('requires tokenInChainId to be defined', () => {
      const { tokenIn, tokenOut, offerer, amount, tokenOutChainId, requestId } = validCombinations[0];
      const validated = PostQuoteRequestBodyJoi.validate({
        tokenIn,
        tokenOut,
        amount,
        offerer,
        tokenOutChainId,
        requestId,
      });
      expect(validated.error?.message).toEqual('"tokenInChainId" is required');
    });

    it('requires tokenOutChainId to be defined', () => {
      const { tokenIn, tokenOut, offerer, amount, tokenInChainId, requestId, type } = validCombinations[0];
      const validated = PostQuoteRequestBodyJoi.validate({
        tokenIn,
        tokenOut,
        amount,
        offerer,
        tokenInChainId,
        requestId,
        type,
      });
      expect(validated.error?.message).toContain('"tokenOutChainId" is required');
    });

    it('requires tokenOutChainId and tokenInChainId to be the same value', () => {
      const { tokenIn, tokenOut, offerer, amount, tokenInChainId, requestId, type } = validCombinations[0];
      const validated = PostQuoteRequestBodyJoi.validate({
        tokenIn,
        tokenOut,
        amount,
        offerer,
        tokenInChainId,
        tokenOutChainId: 5,
        requestId,
        type,
      });
      expect(validated.error?.message).toContain('"tokenOutChainId" must be [ref:tokenInChainId]');
    });
  });

  it('requires tokenInChainId to be supported', () => {
    const validated = PostQuoteRequestBodyJoi.validate(
      Object.assign({}, validCombinations[0], { tokenInChainId: 999999 })
    );
    expect(validated.error?.message).toContain('"tokenInChainId" must be one of');
  });

  describe('PostQuoteResponseJoi', () => {
    it('validates valid inputs', () => {
      const body = {
        chainId: 1,
        requestId: REQUEST_ID,
        offerer: OFFERER,
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: '1000',
        amountOut: '1000000000000000000',
      };
      const validated = PostQuoteResponseJoi.validate(body);
      expect(validated.error).toBeUndefined();
      expect(validated.value).toStrictEqual({
        chainId: 1,
        requestId: REQUEST_ID,
        offerer: OFFERER,
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: '1000',
        amountOut: '1000000000000000000',
      });
    });

    it('requires requestId to be defined', () => {
      const body = {
        chainId: 1,
        tokenIn: USDC,
        tokenOut: WETH,
        offerer: OFFERER,
        amountIn: '1000',
        amountOut: '1000000000000000000',
      };
      const validated = PostQuoteResponseJoi.validate(body);
      expect(validated.error?.message).toEqual('"requestId" is required');
    });

    it('requires tokenIn to be defined', () => {
      const body = {
        chainId: 1,
        requestId: REQUEST_ID,
        tokenOut: WETH,
        offerer: OFFERER,
        amountIn: '1000',
        amountOut: '1000000000000000000',
      };
      const validated = PostQuoteResponseJoi.validate(body);
      expect(validated.error?.message).toEqual('"tokenIn" is required');
    });

    it('requires tokenOut to be defined', () => {
      const body = {
        chainId: 1,
        requestId: REQUEST_ID,
        tokenIn: USDC,
        offerer: OFFERER,
        amountIn: '1000',
        amountOut: '1000000000000000000',
      };
      const validated = PostQuoteResponseJoi.validate(body);
      expect(validated.error?.message).toEqual('"tokenOut" is required');
    });

    it('requires amountIn to be defined', () => {
      const body = {
        chainId: 1,
        requestId: REQUEST_ID,
        tokenIn: USDC,
        offerer: OFFERER,
        tokenOut: WETH,
        amountOut: '1000000000000000000',
      };
      const validated = PostQuoteResponseJoi.validate(body);
      expect(validated.error?.message).toEqual('"amountIn" is required');
    });

    it('requires amountOut to be defined', () => {
      const body = {
        chainId: 1,
        requestId: REQUEST_ID,
        tokenIn: USDC,
        offerer: OFFERER,
        tokenOut: WETH,
        amountIn: '1000000000000000000',
      };
      const validated = PostQuoteResponseJoi.validate(body);
      expect(validated.error?.message).toEqual('"amountOut" is required');
    });
  });

  describe('RfqResponseJoi', () => {
    it('validates valid inputs', () => {
      const body = {
        chainId: 1,
        requestId: REQUEST_ID,
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: '1000',
        amountOut: '1000000000000000000',
      };
      const validated = RfqResponseJoi.validate(body);
      expect(validated.error).toBeUndefined();
      expect(validated.value).toStrictEqual({
        chainId: 1,
        requestId: REQUEST_ID,
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: '1000',
        amountOut: '1000000000000000000',
      });
    });

    it('requires requestId to be defined', () => {
      const body = {
        chainId: 1,
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: '1000',
        amountOut: '1000000000000000000',
      };
      const validated = RfqResponseJoi.validate(body);
      expect(validated.error?.message).toEqual('"requestId" is required');
    });

    it('requires tokenIn to be defined', () => {
      const body = {
        chainId: 1,
        requestId: REQUEST_ID,
        tokenOut: WETH,
        amountIn: '1000',
        amountOut: '1000000000000000000',
      };
      const validated = RfqResponseJoi.validate(body);
      expect(validated.error?.message).toEqual('"tokenIn" is required');
    });

    it('requires tokenOut to be defined', () => {
      const body = {
        chainId: 1,
        requestId: REQUEST_ID,
        tokenIn: USDC,
        amountIn: '1000',
        amountOut: '1000000000000000000',
      };
      const validated = RfqResponseJoi.validate(body);
      expect(validated.error?.message).toEqual('"tokenOut" is required');
    });

    it('requires amountIn to be defined', () => {
      const body = {
        chainId: 1,
        requestId: REQUEST_ID,
        tokenIn: USDC,
        tokenOut: WETH,
        amountOut: '1000000000000000000',
      };
      const validated = RfqResponseJoi.validate(body);
      expect(validated.error?.message).toEqual('"amountIn" is required');
    });

    it('requires amountOut to be defined', () => {
      const body = {
        chainId: 1,
        requestId: REQUEST_ID,
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: '1000000000000000000',
      };
      const validated = RfqResponseJoi.validate(body);
      expect(validated.error?.message).toEqual('"amountOut" is required');
    });

    it('ignores offerer', () => {
      const body = {
        chainId: 1,
        requestId: REQUEST_ID,
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: '1000000000000000000',
        amountOut: '1000000000000000000',
        offerer: OFFERER,
      };
      const validated = RfqResponseJoi.validate(body, {
        allowUnknown: true,
        stripUnknown: true,
      });
      expect(validated.error).toBeUndefined();
      expect(validated.value).toStrictEqual({
        chainId: 1,
        requestId: REQUEST_ID,
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: '1000000000000000000',
        amountOut: '1000000000000000000',
      });
    });

    it('handles null offerer', () => {
      const body = {
        chainId: 1,
        requestId: REQUEST_ID,
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: '1000000000000000000',
        amountOut: '1000000000000000000',
        offerer: null,
      };
      const validated = RfqResponseJoi.validate(body, {
        allowUnknown: true,
        stripUnknown: true,
      });
      expect(validated.error).toBeUndefined();
      expect(validated.value).toStrictEqual({
        chainId: 1,
        requestId: REQUEST_ID,
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: '1000000000000000000',
        amountOut: '1000000000000000000',
      });
    });
  });
});

function lowerUpper(list: string[], str: string): string[] {
  list.push(str.toLowerCase());
  list.push('0x' + str.toUpperCase().slice(2));
  list.push(str);
  return list;
}
