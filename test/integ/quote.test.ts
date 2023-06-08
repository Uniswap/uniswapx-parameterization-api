import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiSubset from 'chai-subset';

import { PostQuoteRequestBody } from '../../lib/handlers/quote';
import AxiosUtils from '../util/axios';

chai.use(chaiAsPromised);
chai.use(chaiSubset);

if (!process.env.UNISWAP_API) {
  throw new Error('Must set UNISWAP_API env variable for integ tests. See README');
}

const API = `${process.env.UNISWAP_API!}/integration/quote`;
const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const OFFERER = '0x0000000000000000000000000000000000000000';
const TOKEN_IN = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

const call = async (method: string, url: string, body: any) => {
  const { data, status } = await AxiosUtils.call(method, url, body);
  expect(status).to.equal(200);
  return data;
};

describe('Quote endpoint integration test', function () {
  describe('Succeeds fetching real quotes from market makers on Mainnet', function () {
    it(`USDT -> WETH`, async () => {
      const quoteReq: PostQuoteRequestBody = {
        requestId: REQUEST_ID,
        tokenInChainId: 1,
        tokenOutChainId: 1,
        offerer: OFFERER,
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amount: '500',
        type: 'EXACT_INPUT',
      };

      const quoteResponse = await call('POST', API, quoteReq);
      expect(quoteResponse).to.be.not.equal(null);
      expect(quoteResponse.requestId).to.be.equal(REQUEST_ID);
      expect(quoteResponse.offerer).to.be.equal(OFFERER);
      expect(quoteResponse.tokenIn).to.be.equal(TOKEN_IN);
      expect(quoteResponse.tokenOut).to.be.equal(TOKEN_OUT);
      expect(quoteResponse.amountIn).to.be.equal(quoteReq.amount);
    });
  });

  // TODO: Enable this test when we have consistent quoters on Polygon
  // describe('Succeeds fetching real quotes from market makers on Polygon', function () {
  // it(`succeeds basic quote polygon`, async () => {
  //   const quoteReq: PostQuoteRequestBody = {
  //     requestId: REQUEST_ID,
  //     tokenInChainId: 137,
  //     tokenOutChainId: 137,
  //     offerer: OFFERER,
  //     tokenIn: TOKEN_IN,
  //     tokenOut: TOKEN_OUT,
  //     amount: '500',
  //     type: 'EXACT_INPUT',
  //   };
  //   const quoteResponse = await call('POST', API, quoteReq);
  //   expect(quoteResponse).to.be.not.equal(null);
  //   expect(quoteResponse.requestId).to.be.equal(REQUEST_ID);
  //   expect(quoteResponse.offerer).to.be.equal(OFFERER);
  //   expect(quoteResponse.tokenIn).to.be.equal(TOKEN_IN);
  //   expect(quoteResponse.tokenOut).to.be.equal(TOKEN_OUT);
  // });
  // });

  it(`fails request validation, bad request id`, async () => {
    const quoteReq: PostQuoteRequestBody = {
      requestId: 'bad_request_id',
      tokenInChainId: 1,
      tokenOutChainId: 1,
      offerer: OFFERER,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amount: '1',
      type: 'EXACT_INPUT',
    };

    await AxiosUtils.callAndExpectFail('POST', API, quoteReq, {
      status: 400,
      data: {
        detail: '"requestId" must be a valid GUID',
        errorCode: 'VALIDATION_ERROR',
      },
    });
  });

  it(`fails request validation, missing amount`, async () => {
    const quoteReq = {
      requestId: REQUEST_ID,
      tokenInChainId: 1,
      tokenOutChainId: 1,
      offerer: OFFERER,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      type: 'EXACT_INPUT',
    };

    await AxiosUtils.callAndExpectFail('POST', API, quoteReq, {
      status: 400,
      data: {
        detail: '"amount" is required',
        errorCode: 'VALIDATION_ERROR',
      },
    });
  });

  it(`fails request validation, incorrect trade type`, async () => {
    const quoteReq = {
      requestId: REQUEST_ID,
      tokenInChainId: 1,
      tokenOutChainId: 1,
      offerer: OFFERER,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      type: 'EXACT_NOTHING',
      amount: '1',
    };

    await AxiosUtils.callAndExpectFail('POST', API, quoteReq, {
      status: 400,
      data: {
        detail: '"type" must be one of [EXACT_INPUT, EXACT_OUTPUT]',
        errorCode: 'VALIDATION_ERROR',
      },
    });
  });

  it(`fails request validation, incorrect tokenIn`, async () => {
    const quoteReq = {
      requestId: REQUEST_ID,
      tokenInChainId: 1,
      tokenOutChainId: 1,
      offerer: OFFERER,
      tokenIn: 'USDC',
      tokenOut: TOKEN_OUT,
      type: 'EXACT_OUTPUT',
      amount: '1',
    };

    await AxiosUtils.callAndExpectFail('POST', API, quoteReq, {
      status: 400,
      data: {
        detail: 'Invalid address',
        errorCode: 'VALIDATION_ERROR',
      },
    });
  });

  it(`fails request validation, incorrect tokenOutChainId`, async () => {
    const quoteReq = {
      requestId: REQUEST_ID,
      tokenInChainId: 1,
      tokenOutChainId: 5,
      offerer: OFFERER,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      type: 'EXACT_OUTPUT',
      amount: '1',
    };

    await AxiosUtils.callAndExpectFail('POST', API, quoteReq, {
      status: 400,
      data: {
        detail: '"tokenOutChainId" must be [ref:tokenInChainId]',
        errorCode: 'VALIDATION_ERROR',
      },
    });
  });
});
