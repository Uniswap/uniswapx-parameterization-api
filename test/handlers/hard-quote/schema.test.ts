import { UnsignedV2DutchOrder } from '@uniswap/uniswapx-sdk';
import { BigNumber, utils } from 'ethers';
import { v4 as uuidv4 } from 'uuid';

import { HardQuoteRequestBodyJoi } from '../../../lib/handlers/hard-quote';
import { getOrderInfo } from '../../entities/HardQuoteRequest.test';

const SWAPPER = '0x0000000000000000000000000000000000000000';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const REQUEST_ID = uuidv4();
const QUOTE_ID = uuidv4();

const validTokenIn = [USDC, WETH].reduce(lowerUpper, []);
const validTokenOut = [USDC, WETH].reduce(lowerUpper, []);
const validAmountIn = ['1', '1000', '1234234', utils.parseEther('1').toString(), utils.parseEther('100000').toString()];
const validHardRequestBodyCombos = validTokenIn.flatMap((tokenIn) =>
  validTokenOut.flatMap((tokenOut) =>
    validAmountIn.flatMap((amount) => {
      const order = new UnsignedV2DutchOrder(
        getOrderInfo({
          input: {
            token: tokenIn,
            startAmount: BigNumber.from(amount),
            endAmount: BigNumber.from(amount),
          },
          outputs: [
            {
              token: tokenOut,
              startAmount: BigNumber.from(amount),
              endAmount: BigNumber.from(amount),
              recipient: SWAPPER,
            },
          ],
        }),
        1
      );
      return {
        requestId: REQUEST_ID,
        quoteId: QUOTE_ID,
        tokenInChainId: 1,
        tokenOutChainId: 1,
        encodedInnerOrder: order.serialize(),
        innerSig:
          '0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      };
    })
  )
);

describe('hard-quote schemas', () => {
  describe('HardQuoteRequestBody', () => {
    it('validates valid hard requests', () => {
      for (const body of validHardRequestBodyCombos) {
        const validated = HardQuoteRequestBodyJoi.validate(body);
        expect(validated.error).toBeUndefined();
        expect(validated.value).toStrictEqual({
          tokenInChainId: 1,
          tokenOutChainId: 1,
          requestId: REQUEST_ID,
          quoteId: QUOTE_ID,
          encodedInnerOrder: body.encodedInnerOrder,
          innerSig: body.innerSig,
        });
      }
    });

    it('requires correct signature length', () => {
      let validated = HardQuoteRequestBodyJoi.validate(
        Object.assign({}, validHardRequestBodyCombos[0], {
          innerSig: '0x1234',
        })
      );
      expect(validated.error?.message).toMatch('Signature in wrong format');

      validated = HardQuoteRequestBodyJoi.validate(
        Object.assign({}, validHardRequestBodyCombos[0], {
          innerSig: '0x123412341234123412341324132412341324132412341324134',
        })
      );
      expect(validated.error?.message).toMatch('Signature in wrong format');

      validated = HardQuoteRequestBodyJoi.validate(
        Object.assign({}, validHardRequestBodyCombos[0], {
          innerSig:
            '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
        })
      );
      expect(validated.error).toBeUndefined();
    });

    it('requires tokenInChainId to be defined', () => {
      const { tokenOutChainId, requestId, quoteId, encodedInnerOrder, innerSig } = validHardRequestBodyCombos[0];
      const validated = HardQuoteRequestBodyJoi.validate({
        tokenOutChainId,
        requestId,
        quoteId,
        encodedInnerOrder,
        innerSig,
      });
      expect(validated.error?.message).toEqual('"tokenInChainId" is required');
    });

    it('requires tokenOutChainId to be defined', () => {
      const { tokenInChainId, requestId, quoteId, encodedInnerOrder, innerSig } = validHardRequestBodyCombos[0];
      const validated = HardQuoteRequestBodyJoi.validate({
        tokenInChainId,
        requestId,
        quoteId,
        encodedInnerOrder,
        innerSig,
      });
      expect(validated.error?.message).toEqual('"tokenOutChainId" is required');
    });

    it('requires tokenOutChainId and tokenInChainId to be the same value', () => {
      const { tokenInChainId, requestId, quoteId, encodedInnerOrder, innerSig } = validHardRequestBodyCombos[0];
      const validated = HardQuoteRequestBodyJoi.validate({
        tokenInChainId,
        tokenOutChainId: 5,
        requestId,
        quoteId,
        encodedInnerOrder,
        innerSig,
      });
      expect(validated.error?.message).toContain('"tokenOutChainId" must be [ref:tokenInChainId]');
    });

    it('requires tokenInChainId to be supported', () => {
      const validated = HardQuoteRequestBodyJoi.validate(
        Object.assign({}, validHardRequestBodyCombos[0], { tokenInChainId: 999999 })
      );
      expect(validated.error?.message).toContain('"tokenInChainId" must be one of');
    });
  });
});

function lowerUpper(list: string[], str: string): string[] {
  list.push(str.toLowerCase());
  list.push('0x' + str.toUpperCase().slice(2));
  list.push(str);
  return list;
}
