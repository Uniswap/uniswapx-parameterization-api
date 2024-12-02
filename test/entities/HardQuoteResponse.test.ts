import {
  CosignedV2DutchOrder,
  CosignerData,
  OrderType,
  UnsignedV2DutchOrder,
  UnsignedV2DutchOrderInfo,
} from '@uniswap/uniswapx-sdk';
import { ethers, Wallet } from 'ethers';
import { parseEther } from 'ethers/lib/utils';

import { HardQuoteRequest } from '../../lib/entities';
import { HardQuoteRequestBody } from '../../lib/handlers/hard-quote';
import { getOrder } from '../handlers/hard-quote/handler.test';
import { V2HardQuoteResponse } from '../../lib/entities/V2HardQuoteResponse';

const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f7';
const SWAPPER = '0x0000000000000000000000000000000000000002';
const FILLER = '0x0000000000000000000000000000000000000001';
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CHAIN_ID = 1;
const fixedTime = 4206969;
jest.spyOn(Date, 'now').mockImplementation(() => fixedTime);

const DEFAULT_EXCLUSIVITY_OVERRIDE_BPS = ethers.BigNumber.from(100);

describe('HardQuoteResponse', () => {
  const swapperWallet = Wallet.createRandom();
  const cosignerWallet = Wallet.createRandom();

  afterEach(() => {
    jest.clearAllMocks();
  });

  const getRequest = async (order: UnsignedV2DutchOrder): Promise<HardQuoteRequestBody> => {
    const { types, domain, values } = order.permitData();
    const sig = await swapperWallet._signTypedData(domain, types, values);
    return {
      requestId: REQUEST_ID,
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      encodedInnerOrder: order.serialize(),
      innerSig: sig,
    };
  };

  const getResponse = async (data: Partial<UnsignedV2DutchOrderInfo>, cosignerData: CosignerData) => {
    const unsigned = getOrder(data);
    const cosignature = cosignerWallet._signingKey().signDigest(unsigned.cosignatureHash(cosignerData));
    const order = CosignedV2DutchOrder.fromUnsignedOrder(
      unsigned,
      cosignerData,
      ethers.utils.joinSignature(cosignature)
    );
    return new V2HardQuoteResponse(new HardQuoteRequest(await getRequest(unsigned), OrderType.Dutch_V2), order);
  };

  it('toResponseJSON', async () => {
    const now = Math.floor(Date.now() / 1000);
    const quoteResponse = await getResponse(
      {},
      {
        decayStartTime: now + 100,
        decayEndTime: now + 200,
        exclusiveFiller: FILLER,
        exclusivityOverrideBps: DEFAULT_EXCLUSIVITY_OVERRIDE_BPS,
        inputOverride: parseEther('1'),
        outputOverrides: [parseEther('1')],
      }
    );
    expect(quoteResponse.toResponseJSON()).toEqual({
      requestId: REQUEST_ID,
      quoteId: QUOTE_ID,
      chainId: CHAIN_ID,
      filler: FILLER,
      encodedOrder: quoteResponse.order.serialize(),
      orderHash: quoteResponse.order.hash(),
    });
  });

  it('toLog', async () => {
    const now = Math.floor(Date.now() / 1000);
    const quoteResponse = await getResponse(
      {},
      {
        decayStartTime: now + 100,
        decayEndTime: now + 200,
        exclusiveFiller: FILLER,
        exclusivityOverrideBps: DEFAULT_EXCLUSIVITY_OVERRIDE_BPS,
        inputOverride: ethers.utils.parseEther('1'),
        outputOverrides: [ethers.utils.parseEther('1')],
      }
    );
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
      filler: FILLER,
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
    });

    it('amountOut uses post cosigned resolution', async () => {
      const now = Math.floor(Date.now() / 1000);
      const quoteResponse = await getResponse(
        {},
        {
          decayStartTime: now + 100,
          decayEndTime: now + 200,
          exclusiveFiller: FILLER,
          exclusivityOverrideBps: DEFAULT_EXCLUSIVITY_OVERRIDE_BPS,
          inputOverride: parseEther('1'),
          outputOverrides: [parseEther('2')],
        }
      );
      expect(quoteResponse.amountOut).toEqual(parseEther('2'));
    });

    it('amountIn uses post cosigned resolution', async () => {
      const now = Math.floor(Date.now() / 1000);
      const quoteResponse = await getResponse(
        {
          cosigner: cosignerWallet.address,
          input: {
            token: TOKEN_IN,
            startAmount: parseEther('1'),
            endAmount: parseEther('1.1'),
          },
          outputs: [
            {
              token: TOKEN_OUT,
              startAmount: parseEther('1'),
              endAmount: parseEther('1'),
              recipient: ethers.constants.AddressZero,
            },
          ],
        },
        {
          decayStartTime: now + 100,
          decayEndTime: now + 200,
          exclusiveFiller: FILLER,
          exclusivityOverrideBps: DEFAULT_EXCLUSIVITY_OVERRIDE_BPS,
          inputOverride: parseEther('0.8'),
          outputOverrides: [parseEther('1')],
        }
      );
      expect(quoteResponse.amountIn).toEqual(parseEther('0.8'));
    });
  });
});
