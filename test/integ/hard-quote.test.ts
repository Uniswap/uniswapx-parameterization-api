import { OrderType, V2DutchOrderBuilder } from '@uniswap/uniswapx-sdk';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiSubset from 'chai-subset';
import { BigNumber, ethers } from 'ethers';
import { v4 as uuidv4 } from 'uuid';

import { HardQuoteRequestBody } from '../../lib/handlers/hard-quote';
import AxiosUtils from '../util/axios';

chai.use(chaiAsPromised);
chai.use(chaiSubset);

if (!process.env.UNISWAP_API) {
  throw new Error('Must set UNISWAP_API env variable for integ tests. See README');
}

if (!process.env.ORDER_SERVICE_URL) {
  throw new Error('Must set ORDER_SERVICE_URL env variable for integ tests. See README');
}

const PARAM_API = `${process.env.UNISWAP_API!}hard-quote`;
const ORDER_SERVICE_API = `${process.env.ORDER_SERVICE_URL}dutch-auction/order`;
const COSIGNER_ADDR = process.env.COSIGNER_ADDR;

const REQUEST_ID = uuidv4();
const builder = new V2DutchOrderBuilder(1, ethers.constants.AddressZero);
const now = Math.floor(Date.now() / 1000);
const swapper = ethers.Wallet.createRandom();
const SWAPPER_ADDRESS = swapper.address;
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const AMOUNT = BigNumber.from('1');

describe('Hard Quote endpoint integration test', function () {
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
        tokenInChainId: 1,
        tokenOutChainId: 1,
      };

      const { data, status } = await AxiosUtils.callPassThroughFail('POST', PARAM_API, quoteReq);
      expect(data.detail).to.equal('"innerSig" is required');
      expect(status).to.equal(400);
    });

    it('missing encodedInnerOrder', async () => {
      const quoteReq = {
        requestId: REQUEST_ID,
        innerSig: '0x',
        tokenInChainId: 1,
        tokenOutChainId: 1,
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
        tokenInChainId: 1,
        tokenOutChainId: 1,
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
        tokenInChainId: 1,
        tokenOutChainId: 1,
      };

      const { data, status } = await AxiosUtils.callPassThroughFail('POST', PARAM_API, quoteReq);
      expect(data.detail).to.equal('Unknown cosigner');
      expect(status).to.equal(400);
    });
  });

  describe('valid requests', async () => {
    // TODO: directly posting to Order Service for now;
    //  once fillers start quoting, send orders through param-api instead
    it('successfully posts order', async () => {
      const cosigner = ethers.Wallet.createRandom();

      const prebuildOrder = builder
        .input({ token: TOKEN_IN, startAmount: AMOUNT, endAmount: AMOUNT })
        .output({ token: TOKEN_OUT, startAmount: AMOUNT, endAmount: AMOUNT, recipient: SWAPPER_ADDRESS })
        .nonce(BigNumber.from(100))
        .cosigner(cosigner.address)
        .deadline(now + 1000)
        .swapper(SWAPPER_ADDRESS);

      const partialOrder = prebuildOrder.buildPartial();

      const cosignerData = {
        decayStartTime: now + 100,
        decayEndTime: now + 200,
        exclusiveFiller: cosigner.address,
        exclusivityOverrideBps: BigNumber.from(0),
        inputOverride: AMOUNT,
        outputOverrides: [AMOUNT],
      };
      const cosignatureHash = partialOrder.cosignatureHash(cosignerData);
      const cosignature = ethers.utils.joinSignature(cosigner._signingKey().signDigest(cosignatureHash));

      const v2Order = prebuildOrder.cosignature(cosignature).cosignerData(cosignerData).build();

      const { domain, types, values } = v2Order.permitData();
      const signature = await swapper._signTypedData(domain, types, values);

      const postOrderReq = {
        encodedOrder: v2Order.serialize(),
        signature,
        chainId: 5, // use GOERLI so that we don't pollute non-testnet DB
        orderType: OrderType.Dutch_V2,
      };

      console.log(JSON.stringify(v2Order));

      const { data, status } = await AxiosUtils.callPassThroughFail('POST', ORDER_SERVICE_API, postOrderReq);
      console.log(JSON.stringify(data));
      expect(status).to.equal(200);
    });
  });
});
