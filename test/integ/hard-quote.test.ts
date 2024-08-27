import { V2DutchOrderBuilder } from '@uniswap/uniswapx-sdk';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiSubset from 'chai-subset';
import { BigNumber, ethers } from 'ethers';
import { v4 as uuidv4 } from 'uuid';

import { HardQuoteRequestBody } from '../../lib/handlers/hard-quote';
import { checkDefined } from '../../lib/preconditions/preconditions';
import AxiosUtils from '../util/axios';

chai.use(chaiAsPromised);
chai.use(chaiSubset);

const COSIGNER_ADDR = checkDefined(
  process.env.COSIGNER_ADDR,
  'Must set COSIGNER_ADDR env variable for integ tests. See README'
);
const INTEG_TEST_PK = checkDefined(
  process.env.INTEG_TEST_PK,
  'Must set INTEG_TEST_PK env variable for integ tests. See README'
);
// PARAM_API base URL
const UNISWAP_API = checkDefined(
  process.env.UNISWAP_API,
  'Must set UNISWAP_API env variable for integ tests. See README'
);

const SEPOLIA = 11155111;
const PARAM_API = `${UNISWAP_API}hard-quote`;

const REQUEST_ID = uuidv4();
const now = Math.floor(Date.now() / 1000);
const swapper = new ethers.Wallet(INTEG_TEST_PK);
const SWAPPER_ADDRESS = swapper.address;
const TOKEN_IN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'; // USDC on Sepolia
const TOKEN_OUT = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'; // WETH on Sepolia
const AMOUNT = BigNumber.from('1');

let builder: V2DutchOrderBuilder;

describe('Hard Quote endpoint integration test', function () {
  beforeEach(() => {
    builder = new V2DutchOrderBuilder(SEPOLIA);
  });

  describe('Invalid requests', async () => {
    it('missing signature', async () => {
      const v2Order = builder
        .input({ token: TOKEN_IN, startAmount: AMOUNT, endAmount: AMOUNT })
        .output({ token: TOKEN_OUT, startAmount: AMOUNT, endAmount: AMOUNT, recipient: SWAPPER_ADDRESS })
        .nonce(BigNumber.from(100))
        .cosigner(ethers.constants.AddressZero)
        .deadline(now + 1000)
        .swapper(SWAPPER_ADDRESS)
        .buildPartial();

      const quoteReq = {
        requestId: REQUEST_ID,
        encodedInnerOrder: v2Order.serialize(),
        tokenInChainId: SEPOLIA,
        tokenOutChainId: SEPOLIA,
      };

      const { data, status } = await AxiosUtils.callPassThroughFail('POST', PARAM_API, quoteReq);
      expect(data.detail).to.equal('"innerSig" is required');
      expect(status).to.equal(400);
    });

    it('missing encodedInnerOrder', async () => {
      const quoteReq = {
        requestId: REQUEST_ID,
        innerSig: '0x',
        tokenInChainId: SEPOLIA,
        tokenOutChainId: SEPOLIA,
      };

      const { data, status } = await AxiosUtils.callPassThroughFail('POST', PARAM_API, quoteReq);
      expect(data.detail).to.equal('"encodedInnerOrder" is required');
      expect(status).to.equal(400);
    });

    it('missing requestId', async () => {
      const v2Order = builder
        .input({ token: TOKEN_IN, startAmount: AMOUNT, endAmount: AMOUNT })
        .output({ token: TOKEN_OUT, startAmount: AMOUNT, endAmount: AMOUNT, recipient: SWAPPER_ADDRESS })
        .nonce(BigNumber.from(100))
        .cosigner(ethers.constants.AddressZero)
        .deadline(now + 1000)
        .swapper(SWAPPER_ADDRESS)
        .buildPartial();
      const { domain, types, values } = v2Order.permitData();
      const signature = await swapper._signTypedData(domain, types, values);

      const quoteReq = {
        encodedInnerOrder: v2Order.serialize(),
        innerSig: signature,
        tokenInChainId: SEPOLIA,
        tokenOutChainId: SEPOLIA,
      };

      const { data, status } = await AxiosUtils.callPassThroughFail('POST', PARAM_API, quoteReq);
      expect(data.detail).to.equal('"requestId" is required');
      expect(status).to.equal(400);
    });

    it('unknown cosigner', async () => {
      const v2Order = builder
        .input({ token: TOKEN_IN, startAmount: AMOUNT, endAmount: AMOUNT })
        .output({ token: TOKEN_OUT, startAmount: AMOUNT, endAmount: AMOUNT, recipient: SWAPPER_ADDRESS })
        .nonce(BigNumber.from(100))
        .cosigner(ethers.constants.AddressZero)
        .deadline(now + 1000)
        .swapper(SWAPPER_ADDRESS)
        .buildPartial();
      const { domain, types, values } = v2Order.permitData();
      const signature = await swapper._signTypedData(domain, types, values);

      const quoteReq: HardQuoteRequestBody = {
        requestId: REQUEST_ID,
        encodedInnerOrder: v2Order.serialize(),
        innerSig: signature,
        tokenInChainId: SEPOLIA,
        tokenOutChainId: SEPOLIA,
      };

      const { data, status } = await AxiosUtils.callPassThroughFail('POST', PARAM_API, quoteReq);
      expect(data.detail).to.equal('Unknown cosigner');
      expect(status).to.equal(400);
    });
  });

  describe('Valid requests', async () => {
    it.skip('successfully posts to order service', async () => {
      const prebuildOrder = builder
        .input({ token: TOKEN_IN, startAmount: AMOUNT, endAmount: AMOUNT })
        .output({ token: TOKEN_OUT, startAmount: AMOUNT, endAmount: AMOUNT, recipient: SWAPPER_ADDRESS })
        .nonce(BigNumber.from(100))
        .cosigner(COSIGNER_ADDR)
        .deadline(now + 1000)
        .swapper(SWAPPER_ADDRESS);

      const v2Order = prebuildOrder.buildPartial();
      const { domain, types, values } = v2Order.permitData();
      const signature = await swapper._signTypedData(domain, types, values);

      const quoteReq: HardQuoteRequestBody = {
        requestId: REQUEST_ID,
        encodedInnerOrder: v2Order.serialize(),
        innerSig: signature,
        tokenInChainId: SEPOLIA,
        tokenOutChainId: SEPOLIA,
        allowNoQuote: true,
      };

      const { data, status } = await AxiosUtils.callPassThroughFail('POST', PARAM_API, quoteReq);
      console.log(data);
      expect(status).to.be.oneOf([200, 201]);
      expect(data.chainId).to.equal(SEPOLIA);
      expect(data.orderHash).to.match(/0x[0-9a-fA-F]{64}/);
    });

    it('successfully skips quotes with forceOpenOrder', async () => {
      const prebuildOrder = builder
        .input({ token: TOKEN_IN, startAmount: AMOUNT, endAmount: AMOUNT })
        .output({ token: TOKEN_OUT, startAmount: AMOUNT, endAmount: AMOUNT, recipient: SWAPPER_ADDRESS })
        .nonce(BigNumber.from(100))
        .cosigner(COSIGNER_ADDR)
        .deadline(now + 1000)
        .swapper(SWAPPER_ADDRESS);

      const v2Order = prebuildOrder.buildPartial();
      const { domain, types, values } = v2Order.permitData();
      const signature = await swapper._signTypedData(domain, types, values);

      const quoteReq: HardQuoteRequestBody = {
        requestId: REQUEST_ID,
        encodedInnerOrder: v2Order.serialize(),
        innerSig: signature,
        tokenInChainId: SEPOLIA,
        tokenOutChainId: SEPOLIA,
        forceOpenOrder: true,
      };

      const { data, status } = await AxiosUtils.callPassThroughFail('POST', PARAM_API, quoteReq);
      console.log(data);
      expect(status).to.be.oneOf([200, 201]);
      expect(data.chainId).to.equal(SEPOLIA);
      expect(data.orderHash).to.match(/0x[0-9a-fA-F]{64}/);
      expect(data.filler).to.equal(ethers.constants.AddressZero);
    });
  });
});
