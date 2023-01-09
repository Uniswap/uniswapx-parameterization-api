import { ethers } from 'ethers';

import { PostQuoteRequestBodyJoi, PostQuoteResponseJoi } from '../../../lib/handlers/quote/schema';

const OFFERER = '0x0000000000000000000000000000000000000000';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

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
      chainId: 1,
      offerer: OFFERER,
      tokenIn,
      tokenOut,
      amountIn: amount,
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
          chainId: 1,
          tokenIn: ethers.utils.getAddress(body.tokenIn),
          tokenOut: ethers.utils.getAddress(body.tokenOut),
          amountIn: body.amountIn,
          offerer: OFFERER,
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
          amountIn: 'abcd',
        })
      );
      expect(validated.error?.message).toMatch('Invalid amount');

      validated = PostQuoteRequestBodyJoi.validate(
        Object.assign({}, validCombinations[0], {
          amountIn: '1234*',
        })
      );
      expect(validated.error?.message).toMatch('Invalid amount');
    });

    it('requires tokenIn to be defined', () => {
      const { tokenOut, amountIn, offerer, chainId } = validCombinations[0];
      const validated = PostQuoteRequestBodyJoi.validate({ tokenOut, amountIn, offerer, chainId });
      expect(validated.error?.message).toEqual('"tokenIn" is required');
    });

    it('requires tokenOut to be defined', () => {
      const { tokenIn, amountIn, offerer, chainId } = validCombinations[0];
      const validated = PostQuoteRequestBodyJoi.validate({ tokenIn, amountIn, offerer, chainId });
      expect(validated.error?.message).toEqual('"tokenOut" is required');
    });

    it('requires amountIn to be defined', () => {
      const { tokenIn, tokenOut, offerer, chainId } = validCombinations[0];
      const validated = PostQuoteRequestBodyJoi.validate({ tokenIn, tokenOut, offerer, chainId });
      expect(validated.error?.message).toEqual('"amountIn" is required');
    });

    it('requires chainId to be defined', () => {
      const { tokenIn, tokenOut, offerer, amountIn } = validCombinations[0];
      const validated = PostQuoteRequestBodyJoi.validate({ tokenIn, tokenOut, offerer, amountIn });
      expect(validated.error?.message).toEqual('"chainId" is required');
    });

    it('requires chainId to be supported', () => {
      const validated = PostQuoteRequestBodyJoi.validate(Object.assign({}, validCombinations[0], { chainId: 999999 }));
      expect(validated.error?.message).toContain('"chainId" must be one of');
    });
  });

  describe('PostQuoteResponseJoi', () => {
    it('validates valid inputs', () => {
      const body = {
        chainId: 1,
        requestId: '1234',
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
        requestId: '1234',
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
        requestId: '1234',
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
        requestId: '1234',
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
        requestId: '1234',
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
        requestId: '1234',
        tokenIn: USDC,
        offerer: OFFERER,
        tokenOut: WETH,
        amountIn: '1000000000000000000',
      };
      const validated = PostQuoteResponseJoi.validate(body);
      expect(validated.error?.message).toEqual('"amountOut" is required');
    });
  });
});

function lowerUpper(list: string[], str: string): string[] {
  list.push(str.toLowerCase());
  list.push('0x' + str.toUpperCase().slice(2));
  list.push(str);
  return list;
}
