import { TradeType } from '@uniswap/sdk-core';
import { CosignerData, OrderType, UnsignedV2DutchOrder } from '@uniswap/uniswapx-sdk';
import { BigNumber, ethers } from 'ethers';

import { HardQuoteRequest, QuoteResponse } from '../../../lib/entities';
import { getCosignerData } from '../../../lib/handlers/hard-quote/handler';
import { OrderDeadlineExpired } from '../../../lib/util/errors';

const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const REQUEST_ID = 'b83f397c-8ef4-4801-a9b7-6e79155049f6';
const TOKEN_IN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const TOKEN_OUT = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const RAW_AMOUNT = BigNumber.from('1000000000000000000');
const CHAIN_ID = 1;

const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';

function buildV2Order(deadline: number): UnsignedV2DutchOrder {
  const info = {
    deadline,
    reactor: ethers.constants.AddressZero,
    swapper: ethers.constants.AddressZero,
    nonce: BigNumber.from(100),
    additionalValidationContract: ethers.constants.AddressZero,
    additionalValidationData: '0x',
    cosigner: ethers.constants.AddressZero,
    input: { token: TOKEN_IN, startAmount: RAW_AMOUNT, endAmount: RAW_AMOUNT },
    outputs: [
      {
        token: TOKEN_OUT,
        startAmount: RAW_AMOUNT,
        endAmount: RAW_AMOUNT.mul(99).div(100),
        recipient: ethers.constants.AddressZero,
      },
    ],
  } as any;
  return new UnsignedV2DutchOrder(info, CHAIN_ID, PERMIT2);
}

function makeRequest(deadline: number): HardQuoteRequest {
  const req = Object.create(HardQuoteRequest.prototype) as HardQuoteRequest;
  (req as any).order = buildV2Order(deadline);
  (req as any).data = {
    requestId: REQUEST_ID,
    tokenInChainId: CHAIN_ID,
    tokenOutChainId: CHAIN_ID,
    encodedInnerOrder: '0x',
    innerSig: '0x',
  };
  return req;
}

function makeQuote(): QuoteResponse {
  return new QuoteResponse(
    {
      chainId: CHAIN_ID,
      amountOut: RAW_AMOUNT,
      amountIn: RAW_AMOUNT,
      quoteId: QUOTE_ID,
      requestId: REQUEST_ID,
      swapper: ethers.constants.AddressZero,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
    } as any,
    TradeType.EXACT_INPUT,
    { fillerName: 'mock', endpoint: 'mock' }
  );
}

describe('V2 cosigner: decayEndTime vs deadline', () => {
  it('throws OrderDeadlineExpired when getDecayEndTime > order deadline (chainId 1: decay ends now+84)', async () => {
    // Mainnet: getDecayStartTime = now+24, getDecayEndTime = start+60 = now+84.
    // Set deadline to now+30 — decay would end 54s after deadline.
    const now = Math.floor(Date.now() / 1000);
    const req = makeRequest(now + 30);
    // EXE-28: this must be a typed client error (-> HTTP 400), not a plain
    // Error that the base handler surfaces as a retryable 5xx.
    await expect(getCosignerData(req, makeQuote(), OrderType.Dutch_V2)).rejects.toBeInstanceOf(
      OrderDeadlineExpired
    );
    await expect(getCosignerData(req, makeQuote(), OrderType.Dutch_V2)).rejects.toThrow(/deadline/);
  });

  it('passes when order deadline comfortably exceeds decay end', async () => {
    const now = Math.floor(Date.now() / 1000);
    const req = makeRequest(now + 1000);
    const data = (await getCosignerData(req, makeQuote(), OrderType.Dutch_V2)) as CosignerData;
    expect(data.decayEndTime).toBeLessThanOrEqual(req.order.info.deadline);
  });
});
