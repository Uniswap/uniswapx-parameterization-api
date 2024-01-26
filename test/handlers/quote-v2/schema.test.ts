import { constants, utils } from 'ethers';
import { v4 as uuidv4 } from 'uuid';
import { IndicativeQuoteRequestBodyJoi, IndicativeQuoteResponseJoi } from '../../../lib/handlers/quote-v2';

const SWAPPER = '0x0000000000000000000000000000000000000000';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const REQUEST_ID = uuidv4();
const QUOTE_ID = uuidv4();

const validTokenIn = [USDC, WETH].reduce(lowerUpper, []);
const validTokenOut = [USDC, WETH].reduce(lowerUpper, []);
const validAmountIn = ['1', '1000', '1234234', utils.parseEther('1').toString(), utils.parseEther('100000').toString()];
const validIndicativeRequestBodyCombos = validTokenIn.flatMap((tokenIn) =>
  validTokenOut.flatMap((tokenOut) =>
    validAmountIn.flatMap((amount) => ({
      requestId: REQUEST_ID,
      tokenInChainId: 1,
      tokenOutChainId: 1,
      swapper: SWAPPER,
      tokenIn,
      tokenOut,
      cosigner: constants.AddressZero,
      amount: amount,
      type: 'EXACT_INPUT',
      numOutputs: 1,
    }))
  )
);
const validIndicativeQuoteReponse = {
  tokenInChainId: 1,
  tokenOutChainId: 1,
  requestId: REQUEST_ID,
  swapper: SWAPPER,
  tokenIn: USDC,
  tokenOut: WETH,
  amountIn: '1000',
  amountOut: '1000000000000000000',
  cosigner: constants.AddressZero,
  quoteId: QUOTE_ID,
  filler: constants.AddressZero,
};

describe('quote-v2 schemas', () => {
  describe('IndicativeQuoteRequestBody', () => {
    it('validates valid indicative requests', () => {
      for (const body of validIndicativeRequestBodyCombos) {
        const validated = IndicativeQuoteRequestBodyJoi.validate(body);
        expect(validated.error).toBeUndefined();
        expect(validated.value).toStrictEqual({
          tokenInChainId: 1,
          tokenOutChainId: 1,
          requestId: REQUEST_ID,
          swapper: SWAPPER,
          tokenIn: utils.getAddress(body.tokenIn),
          tokenOut: utils.getAddress(body.tokenOut),
          amount: body.amount,
          type: 'EXACT_INPUT',
          cosigner: constants.AddressZero,
          numOutputs: 1,
        });
      }
    });
    it('adds missing 0x prefix', () => {
      let validated = IndicativeQuoteRequestBodyJoi.validate(
        Object.assign({}, validIndicativeRequestBodyCombos[0], {
          tokenIn: 'A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        })
      );
      expect(validated.error?.message).toBeUndefined();
      expect(validated.value.tokenIn).toEqual('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');

      validated = IndicativeQuoteRequestBodyJoi.validate(
        Object.assign({}, validIndicativeRequestBodyCombos[0], {
          tokenOut: 'A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        })
      );
      expect(validated.error?.message).toBeUndefined();
      expect(validated.value.tokenOut).toEqual('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    });

    it('requires correct address length', () => {
      let validated = IndicativeQuoteRequestBodyJoi.validate(
        Object.assign({}, validIndicativeRequestBodyCombos[0], {
          tokenIn: '0x1234',
        })
      );
      expect(validated.error?.message).toMatch('Invalid address');

      validated = IndicativeQuoteRequestBodyJoi.validate(
        Object.assign({}, validIndicativeRequestBodyCombos[0], {
          tokenIn: '0x123412341234123412341324132412341324132412341324134',
        })
      );
      expect(validated.error?.message).toMatch('Invalid address');
    });

    it('requires amount to be a string number', () => {
      let validated = IndicativeQuoteRequestBodyJoi.validate(
        Object.assign({}, validIndicativeRequestBodyCombos[0], {
          amount: 'abcd',
        })
      );
      expect(validated.error?.message).toMatch('Invalid amount');

      validated = IndicativeQuoteRequestBodyJoi.validate(
        Object.assign({}, validIndicativeRequestBodyCombos[0], {
          amount: '1234*',
        })
      );
      expect(validated.error?.message).toMatch('Invalid amount');
    });

    it('requires tokenIn to be defined', () => {
      const { tokenOut, amount, swapper, tokenInChainId, tokenOutChainId, requestId } =
        validIndicativeRequestBodyCombos[0];
      const validated = IndicativeQuoteRequestBodyJoi.validate({
        tokenOut,
        amount,
        swapper,
        tokenInChainId,
        tokenOutChainId,
        requestId,
      });
      expect(validated.error?.message).toEqual('"tokenIn" is required');
    });

    it('requires tokenOut to be defined', () => {
      const { tokenIn, amount, swapper, tokenInChainId, tokenOutChainId, requestId } =
        validIndicativeRequestBodyCombos[0];
      const validated = IndicativeQuoteRequestBodyJoi.validate({
        tokenIn,
        amount,
        swapper,
        tokenInChainId,
        tokenOutChainId,
        requestId,
      });
      expect(validated.error?.message).toEqual('"tokenOut" is required');
    });

    it('requires amount to be defined', () => {
      const { tokenIn, tokenOut, swapper, tokenInChainId, tokenOutChainId, requestId } =
        validIndicativeRequestBodyCombos[0];
      const validated = IndicativeQuoteRequestBodyJoi.validate({
        tokenIn,
        tokenOut,
        swapper,
        tokenInChainId,
        tokenOutChainId,
        requestId,
      });
      expect(validated.error?.message).toEqual('"amount" is required');
    });

    it('requires tokenInChainId to be defined', () => {
      const { tokenIn, tokenOut, swapper, amount, tokenOutChainId, requestId } = validIndicativeRequestBodyCombos[0];
      const validated = IndicativeQuoteRequestBodyJoi.validate({
        tokenIn,
        tokenOut,
        amount,
        swapper,
        tokenOutChainId,
        requestId,
      });
      expect(validated.error?.message).toEqual('"tokenInChainId" is required');
    });

    it('requires tokenOutChainId to be defined', () => {
      const { tokenIn, tokenOut, swapper, amount, tokenInChainId, requestId, type } =
        validIndicativeRequestBodyCombos[0];
      const validated = IndicativeQuoteRequestBodyJoi.validate({
        tokenIn,
        tokenOut,
        amount,
        swapper,
        tokenInChainId,
        requestId,
        type,
      });
      expect(validated.error?.message).toContain('"tokenOutChainId" is required');
    });

    it('requires cosigner to be defined', () => {
      const { tokenIn, tokenOut, swapper, amount, tokenInChainId, tokenOutChainId, requestId, type } =
        validIndicativeRequestBodyCombos[0];
      const validated = IndicativeQuoteRequestBodyJoi.validate({
        tokenIn,
        tokenOut,
        amount,
        swapper,
        tokenInChainId,
        tokenOutChainId,
        requestId,
        type,
      });
      expect(validated.error?.message).toContain('"cosigner" is required');
    });

    it('requires tokenOutChainId and tokenInChainId to be the same value', () => {
      const { tokenIn, tokenOut, swapper, amount, tokenInChainId, requestId, type } =
        validIndicativeRequestBodyCombos[0];
      const validated = IndicativeQuoteRequestBodyJoi.validate({
        tokenIn,
        tokenOut,
        amount,
        swapper,
        tokenInChainId,
        tokenOutChainId: 5,
        requestId,
        type,
      });
      expect(validated.error?.message).toContain('"tokenOutChainId" must be [ref:tokenInChainId]');
    });
  });

  it('requires tokenInChainId to be supported', () => {
    const validated = IndicativeQuoteRequestBodyJoi.validate(
      Object.assign({}, validIndicativeRequestBodyCombos[0], { tokenInChainId: 999999 })
    );
    expect(validated.error?.message).toContain('"tokenInChainId" must be one of');
  });

  describe('IndicativeQuoteResponse', () => {
    it('validates valid indicative responses', () => {
      const validated = IndicativeQuoteResponseJoi.validate(validIndicativeQuoteReponse);
      expect(validated.error).toBeUndefined();
      expect(validated.value).toStrictEqual({
        tokenInChainId: 1,
        tokenOutChainId: 1,
        requestId: REQUEST_ID,
        swapper: SWAPPER,
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: '1000',
        amountOut: '1000000000000000000',
        cosigner: constants.AddressZero,
        quoteId: QUOTE_ID,
        filler: constants.AddressZero,
      });
    });

    it('requires tokenInChainId to be defined', () => {
      const validated = IndicativeQuoteResponseJoi.validate(
        Object.assign({}, validIndicativeQuoteReponse, { tokenInChainId: undefined })
      );
      expect(validated.error?.message).toEqual('"tokenInChainId" is required');
    });

    it('requires tokenOutChainId to be defined', () => {
      const validated = IndicativeQuoteResponseJoi.validate(
        Object.assign({}, validIndicativeQuoteReponse, { tokenOutChainId: undefined })
      );
      expect(validated.error?.message).toEqual('"tokenOutChainId" is required');
    });

    it('requires requestId to be defined', () => {
      const validated = IndicativeQuoteResponseJoi.validate(
        Object.assign({}, validIndicativeQuoteReponse, { requestId: undefined })
      );
      expect(validated.error?.message).toEqual('"requestId" is required');
    });

    it('requires tokenIn to be defined', () => {
      const validated = IndicativeQuoteResponseJoi.validate(
        Object.assign({}, validIndicativeQuoteReponse, { tokenIn: undefined })
      );
      expect(validated.error?.message).toEqual('"tokenIn" is required');
    });

    it('requires amountIn to be defined', () => {
      const validated = IndicativeQuoteResponseJoi.validate(
        Object.assign({}, validIndicativeQuoteReponse, { amountIn: undefined })
      );
      expect(validated.error?.message).toEqual('"amountIn" is required');
    });

    it('requires tokenOut to be defined', () => {
      const validated = IndicativeQuoteResponseJoi.validate(
        Object.assign({}, validIndicativeQuoteReponse, { tokenOut: undefined })
      );
      expect(validated.error?.message).toEqual('"tokenOut" is required');
    });

    it('requires amountOut to be defined', () => {
      const validated = IndicativeQuoteResponseJoi.validate(
        Object.assign({}, validIndicativeQuoteReponse, { amountOut: undefined })
      );
      expect(validated.error?.message).toEqual('"amountOut" is required');
    });

    it('requires quoteId to be defined', () => {
      const validated = IndicativeQuoteResponseJoi.validate(
        Object.assign({}, validIndicativeQuoteReponse, { quoteId: undefined })
      );
      expect(validated.error?.message).toEqual('"quoteId" is required');
    });

    it('requires cosigner to be defined', () => {
      const validated = IndicativeQuoteResponseJoi.validate(
        Object.assign({}, validIndicativeQuoteReponse, { cosigner: undefined })
      );
      expect(validated.error?.message).toEqual('"cosigner" is required');
    });
  });
});

function lowerUpper(list: string[], str: string): string[] {
  list.push(str.toLowerCase());
  list.push('0x' + str.toUpperCase().slice(2));
  list.push(str);
  return list;
}
