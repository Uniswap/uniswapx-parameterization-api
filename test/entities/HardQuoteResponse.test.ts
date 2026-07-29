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
import { V2HardQuoteResponse } from '../../lib/entities/V2HardQuoteResponse';
import { HardQuoteRequestBody } from '../../lib/handlers/hard-quote';
import { getOrder } from '../fixtures/hard-quote';

const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f7';
const SWAPPER = '0x0000000000000000000000000000000000000002';
const FILLER = '0x0000000000000000000000000000000000000001';
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CHAIN_ID = 1;
const fixedTime = 4206969;
// Only Date.now() is mocked. The `getOrder` fixture reads the clock via `new Date().getTime()`,
// which ignores this spy, so the order deadline stays a real future timestamp. Do NOT add
// `resetMocks`/`restoreMocks` to jest.config.js without revisiting: mockReset() drops the
// implementation, Date.now() would return undefined, and every `now + 100` below becomes NaN.
// `jest.clearAllMocks()` in afterEach is safe -- mockClear() keeps the implementation.
jest.spyOn(Date, 'now').mockImplementation(() => fixedTime);

const DEFAULT_EXCLUSIVITY_OVERRIDE_BPS = ethers.BigNumber.from(100);

describe('HardQuoteResponse', () => {
  const swapperWallet = Wallet.createRandom();
  const cosignerWallet = Wallet.createRandom();

  afterEach(() => {
    jest.clearAllMocks();
  });

  const getRequest = async (
    order: UnsignedV2DutchOrder,
    // `null` omits quoteId from the body. An explicit `undefined` would re-trigger the default.
    quoteId: string | null = QUOTE_ID
  ): Promise<HardQuoteRequestBody> => {
    const { types, domain, values } = order.permitData();
    const sig = await swapperWallet._signTypedData(domain, types, values);
    return {
      requestId: REQUEST_ID,
      ...(quoteId !== null && { quoteId }),
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      encodedInnerOrder: order.serialize(),
      innerSig: sig,
    };
  };

  const getResponse = async (
    data: Partial<UnsignedV2DutchOrderInfo>,
    cosignerData: CosignerData,
    quoteId: string | null = QUOTE_ID
  ) => {
    // getOrder defaults swapper to AddressZero -- which is also the default for reactor,
    // cosigner, additionalValidationContract and outputs[0].recipient, so an
    // `swapper: AddressZero` assertion could not tell `swapper` apart from any of them.
    // Overriding makes the swapper assertions load-bearing. (innerSig is still signed by
    // swapperWallet; nothing under test recovers or validates the permit signer.)
    const unsigned = getOrder({ swapper: SWAPPER, ...data });
    const cosignature = cosignerWallet._signingKey().signDigest(unsigned.cosignatureHash(cosignerData));
    const order = CosignedV2DutchOrder.fromUnsignedOrder(
      unsigned,
      cosignerData,
      ethers.utils.joinSignature(cosignature)
    );
    return new V2HardQuoteResponse(
      new HardQuoteRequest(await getRequest(unsigned, quoteId), OrderType.Dutch_V2),
      order
    );
  };

  const makeCosignerData = (now: number, overrides: Partial<CosignerData> = {}): CosignerData => ({
    decayStartTime: now + 100,
    decayEndTime: now + 200,
    exclusiveFiller: FILLER,
    exclusivityOverrideBps: DEFAULT_EXCLUSIVITY_OVERRIDE_BPS,
    inputOverride: parseEther('1'),
    outputOverrides: [parseEther('1')],
    ...overrides,
  });

  it('toResponseJSON', async () => {
    const now = Math.floor(Date.now() / 1000);
    const quoteResponse = await getResponse({}, makeCosignerData(now));
    expect(quoteResponse.toResponseJSON()).toEqual({
      // HardQuoteRequest's constructor does `requestId: _data.quoteId ?? uuidv4()`, so the
      // echoed requestId is the indicative quoteId; the client's REQUEST_ID is discarded.
      requestId: QUOTE_ID,
      quoteId: QUOTE_ID,
      chainId: CHAIN_ID,
      filler: FILLER,
      encodedOrder: quoteResponse.order.serialize(),
      orderHash: quoteResponse.order.hash(),
    });
  });

  it('requestId is the indicative quoteId, not the client-supplied requestId', async () => {
    const now = Math.floor(Date.now() / 1000);
    const quoteResponse = await getResponse({}, makeCosignerData(now));
    expect(quoteResponse.requestId).toEqual(QUOTE_ID);
    expect(quoteResponse.requestId).not.toEqual(REQUEST_ID);
  });

  it('toLog', async () => {
    const now = Math.floor(Date.now() / 1000);
    const quoteResponse = await getResponse({}, makeCosignerData(now));
    expect(quoteResponse.toLog()).toEqual({
      createdAt: Math.floor(fixedTime / 1000).toString(),
      createdAtMs: fixedTime.toString(),
      amountOut: parseEther('1').toString(),
      amountIn: parseEther('1').toString(),
      quoteId: QUOTE_ID,
      requestId: QUOTE_ID,
      swapper: SWAPPER,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      filler: FILLER,
      orderHash: quoteResponse.order.hash(),
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
    });
  });

  it('amountOut uses post cosigned resolution', async () => {
    const now = Math.floor(Date.now() / 1000);
    const quoteResponse = await getResponse(
      {},
      makeCosignerData(now, { inputOverride: parseEther('1'), outputOverrides: [parseEther('2')] })
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
      makeCosignerData(now, { inputOverride: parseEther('0.8'), outputOverrides: [parseEther('1')] })
    );
    expect(quoteResponse.amountIn).toEqual(parseEther('0.8'));
  });

  // Characterization test for a known wart, NOT an endorsement: toResponseJSON reads the raw
  // `request.quoteId` while the `quoteId` getter used by toLog falls back to a fresh uuidv4()
  // on every access. With no quoteId on the request the two disagree, and toLog is not even
  // self-consistent between calls, so hardresponses.quoteid cannot be joined to
  // postedorders.quoteid for open orders. Delete this test when the getter is memoized.
  it('with no request quoteId, toResponseJSON omits quoteId while toLog fabricates a new one', async () => {
    const now = Math.floor(Date.now() / 1000);
    const quoteResponse = await getResponse({}, makeCosignerData(now), null);

    expect(quoteResponse.toResponseJSON().quoteId).toBeUndefined();
    expect(quoteResponse.toLog().quoteId).toEqual(expect.any(String));
    expect(quoteResponse.toLog().quoteId).not.toEqual(quoteResponse.toLog().quoteId);
  });
});
