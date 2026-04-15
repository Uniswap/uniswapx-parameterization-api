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
const SEPOLIA_RPC = 'https://sepolia.infura.io/v3/84842078b09946638c03157f83405213';
const PARAM_API = `${UNISWAP_API}hard-quote`;

const REQUEST_ID = uuidv4();
const now = Math.floor(Date.now() / 1000);
const faucetWallet = new ethers.Wallet(INTEG_TEST_PK);
const FAUCET_ADDRESS = faucetWallet.address;
const TOKEN_IN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'; // USDC on Sepolia
const TOKEN_OUT = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'; // WETH on Sepolia
const AMOUNT = BigNumber.from('1');

const PERMIT2_ADDRESS = '0x000000000022d473030f116ddee9f6b43ac78ba3';

// Amount of USDC (6 decimals) and ETH to fund the dynamic wallet
const USDC_FUND_AMOUNT = BigNumber.from(100); // 100 wei of USDC (order only needs 1)
const ETH_FUND_AMOUNT = ethers.utils.parseEther('0.001'); // enough for gas

let builder: V2DutchOrderBuilder;
let provider: ethers.providers.JsonRpcProvider;
let dynamicWallet: ethers.Wallet;
let dynamicSwapper: ethers.Wallet;
let faucetSigner: ethers.Wallet;

describe('Hard Quote endpoint integration test', function () {
  before(async function () {
    this.timeout(120000);
    provider = new ethers.providers.JsonRpcProvider(SEPOLIA_RPC, SEPOLIA);
    faucetSigner = faucetWallet.connect(provider);

    // Generate a fresh wallet for tests that post orders to avoid TOO_MANY_OPEN_ORDERS
    dynamicWallet = ethers.Wallet.createRandom();
    dynamicSwapper = dynamicWallet.connect(provider);
    console.log(`Dynamic test wallet: ${dynamicWallet.address}`);
    console.log(`Dynamic test wallet PK: ${dynamicWallet.privateKey}`);

    // Fund the dynamic wallet with ETH and USDC from the faucet wallet
    const ethTx = await faucetSigner.sendTransaction({
      to: dynamicWallet.address,
      value: ETH_FUND_AMOUNT,
    });
    const usdc = new ethers.Contract(TOKEN_IN, [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
  ], faucetSigner);
    const usdcTx = await usdc.transfer(dynamicWallet.address, USDC_FUND_AMOUNT);
    await Promise.all([ethTx.wait(1), usdcTx.wait(1)]);

    // Approve USDC to Permit2 so the order service's onchain validation passes
    const usdcDynamic = new ethers.Contract(TOKEN_IN, [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
  ], dynamicSwapper);
    const approveTx = await usdcDynamic.approve(PERMIT2_ADDRESS, ethers.constants.MaxUint256);
    await approveTx.wait(1);

    const balance = await usdcDynamic.balanceOf(dynamicWallet.address);
    console.log(`Funded dynamic wallet (USDC balance: ${balance.toString()})`);
  });

  after(async function () {
    this.timeout(60000);
    try {
      // Return USDC balance to faucet
      const usdc = new ethers.Contract(TOKEN_IN, [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
  ], dynamicSwapper);
      const usdcBalance: BigNumber = await usdc.balanceOf(dynamicWallet.address);
      if (usdcBalance.gt(0)) {
        const usdcTx = await usdc.transfer(FAUCET_ADDRESS, usdcBalance);
        await usdcTx.wait();
      }

      // Return remaining ETH to faucet (minus gas for this tx)
      const ethBalance = await provider.getBalance(dynamicWallet.address);
      const gasPrice = await provider.getGasPrice();
      const gasCost = gasPrice.mul(21000);
      const refundAmount = ethBalance.sub(gasCost);
      if (refundAmount.gt(0)) {
        const ethTx = await dynamicSwapper.sendTransaction({
          to: FAUCET_ADDRESS,
          value: refundAmount,
          gasLimit: 21000,
          gasPrice,
        });
        await ethTx.wait();
      }
      console.log('Refunded faucet wallet');
    } catch (e) {
      console.error('Failed to refund faucet wallet:', e);
    }
  });

  beforeEach(() => {
    builder = new V2DutchOrderBuilder(SEPOLIA);
  });

  describe('Invalid requests', async () => {
    it('missing signature', async () => {
      const v2Order = builder
        .input({ token: TOKEN_IN, startAmount: AMOUNT, endAmount: AMOUNT })
        .output({ token: TOKEN_OUT, startAmount: AMOUNT, endAmount: AMOUNT, recipient: FAUCET_ADDRESS })
        .nonce(BigNumber.from(100))
        .cosigner(ethers.constants.AddressZero)
        .deadline(now + 1000)
        .swapper(FAUCET_ADDRESS)
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
        .output({ token: TOKEN_OUT, startAmount: AMOUNT, endAmount: AMOUNT, recipient: FAUCET_ADDRESS })
        .nonce(BigNumber.from(100))
        .cosigner(ethers.constants.AddressZero)
        .deadline(now + 1000)
        .swapper(FAUCET_ADDRESS)
        .buildPartial();
      const { domain, types, values } = v2Order.permitData();
      const signature = await faucetWallet._signTypedData(domain, types, values);

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
        .output({ token: TOKEN_OUT, startAmount: AMOUNT, endAmount: AMOUNT, recipient: FAUCET_ADDRESS })
        .nonce(BigNumber.from(100))
        .cosigner(ethers.constants.AddressZero)
        .deadline(now + 1000)
        .swapper(FAUCET_ADDRESS)
        .buildPartial();
      const { domain, types, values } = v2Order.permitData();
      const signature = await faucetWallet._signTypedData(domain, types, values);

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
        .output({ token: TOKEN_OUT, startAmount: AMOUNT, endAmount: AMOUNT, recipient: FAUCET_ADDRESS })
        .nonce(BigNumber.from(100))
        .cosigner(COSIGNER_ADDR)
        .deadline(now + 1000)
        .swapper(FAUCET_ADDRESS);

      const v2Order = prebuildOrder.buildPartial();
      const { domain, types, values } = v2Order.permitData();
      const signature = await faucetWallet._signTypedData(domain, types, values);

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
        .output({ token: TOKEN_OUT, startAmount: AMOUNT, endAmount: AMOUNT, recipient: dynamicWallet.address })
        .nonce(BigNumber.from(100))
        .cosigner(COSIGNER_ADDR)
        .deadline(now + 1000)
        .swapper(dynamicWallet.address);

      const v2Order = prebuildOrder.buildPartial();
      const { domain, types, values } = v2Order.permitData();
      const signature = await dynamicWallet._signTypedData(domain, types, values);

      const quoteReq: HardQuoteRequestBody = {
        requestId: REQUEST_ID,
        quoteId: uuidv4(),
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
