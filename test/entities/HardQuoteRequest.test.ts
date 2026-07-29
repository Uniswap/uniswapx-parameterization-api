import { TradeType } from '@uniswap/sdk-core';
import { OrderType, UnsignedV2DutchOrder, UnsignedV3DutchOrder, V3DutchOrderBuilder } from '@uniswap/uniswapx-sdk';
import { BigNumber, ethers } from 'ethers';

import { HardQuoteRequest } from '../../lib/entities';
import { HardQuoteRequestBody } from '../../lib/handlers/hard-quote';
import { ProtocolVersion } from '../../lib/providers';
import { getOrderInfo } from '../fixtures/hard-quote';

const RAW_AMOUNT = BigNumber.from('1000000');
// Deliberately DIFFERENT uuids. These were identical, so every toCleanJSON assertion below
// held regardless of whether requestId carried the caller's id or the quoteId.
const REQUEST_ID = 'b45c2d1e-7f30-4a92-8c65-1d8e4f2a9b03';
const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
// HardQuoteRequest's constructor derives `requestId: _data.quoteId ?? uuidv4()`, so every JSON
// view below reports the indicative QUOTE_ID as the requestId -- the caller's REQUEST_ID is
// discarded. This is deliberate: `hardrequests` has no quoteId column, so requestId is how the
// indicative quoteId reaches Redshift. Named rather than inlined so the substitution is visible.
const DERIVED_REQUEST_ID = QUOTE_ID;
const SWAPPER = '0x0000000000000000000000000000000000000000';
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CHAIN_ID = 1;

const makeRequest = (
  data: Partial<HardQuoteRequestBody>,
  orderType: OrderType = OrderType.Dutch_V2,
  chainId: number = CHAIN_ID
): HardQuoteRequest => {
  return new HardQuoteRequest(
    Object.assign(
      {
        requestId: REQUEST_ID,
        quoteId: QUOTE_ID,
        tokenInChainId: chainId,
        tokenOutChainId: chainId,
        encodedInnerOrder: '0x',
        innerSig: '0x',
      },
      data
    ),
    orderType
  );
};

const V3_CHAIN_ID = 42161;

const getV3Order = (swapper: string): UnsignedV3DutchOrder => {
  const now = Math.floor(new Date().getTime() / 1000);
  return new V3DutchOrderBuilder(V3_CHAIN_ID)
    .cosigner(ethers.constants.AddressZero)
    .deadline(now + 1000)
    .swapper(swapper)
    .nonce(BigNumber.from(100))
    .startingBaseFee(BigNumber.from(0))
    .input({
      token: TOKEN_IN,
      startAmount: RAW_AMOUNT,
      curve: {
        relativeBlocks: [],
        relativeAmounts: [],
      },
      maxAmount: RAW_AMOUNT,
      adjustmentPerGweiBaseFee: BigNumber.from(0),
    })
    .output({
      token: TOKEN_OUT,
      startAmount: RAW_AMOUNT,
      curve: {
        relativeBlocks: [4],
        relativeAmounts: [BigInt(4)],
      },
      recipient: ethers.constants.AddressZero,
      minAmount: RAW_AMOUNT.sub(4),
      adjustmentPerGweiBaseFee: BigNumber.from(0),
    })
    .buildPartial();
};

describe('QuoteRequest', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('parses order properly', () => {
    const order = new UnsignedV2DutchOrder(
      getOrderInfo({
        swapper: SWAPPER,
      }),
      CHAIN_ID
    );
    const request = makeRequest({ encodedInnerOrder: order.serialize(), innerSig: '0x' });
    expect(request.swapper).toEqual(SWAPPER);
    expect(request.tokenIn).toEqual(TOKEN_IN);
    expect(request.tokenOut).toEqual(TOKEN_OUT);
    expect(request.numOutputs).toEqual(1);
    expect(request.amount).toEqual(RAW_AMOUNT);
    expect(request.type).toEqual(TradeType.EXACT_INPUT);
  });

  it('toCleanJSON', async () => {
    const order = new UnsignedV2DutchOrder(
      getOrderInfo({
        swapper: SWAPPER,
      }),
      CHAIN_ID
    );
    const request = makeRequest({ encodedInnerOrder: order.serialize(), innerSig: '0x' });
    expect(request.toCleanJSON()).toEqual({
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      requestId: DERIVED_REQUEST_ID,
      quoteId: QUOTE_ID,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amount: RAW_AMOUNT.toString(),
      swapper: ethers.constants.AddressZero,
      type: 'EXACT_INPUT',
      numOutputs: 1,
      protocol: ProtocolVersion.V2,
    });
  });

  it('toOpposingCleanJSON', async () => {
    const order = new UnsignedV2DutchOrder(
      getOrderInfo({
        swapper: SWAPPER,
      }),
      CHAIN_ID
    );
    const request = makeRequest({ encodedInnerOrder: order.serialize(), innerSig: '0x' });
    expect(request.toOpposingCleanJSON()).toEqual({
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      requestId: DERIVED_REQUEST_ID,
      quoteId: QUOTE_ID,
      tokenIn: TOKEN_OUT,
      tokenOut: TOKEN_IN,
      amount: RAW_AMOUNT.toString(),
      swapper: ethers.constants.AddressZero,
      type: 'EXACT_OUTPUT',
      numOutputs: 1,
      protocol: ProtocolVersion.V2,
    });
  });

  it('exposes protocol v2 for Dutch_V2 orders', () => {
    const order = new UnsignedV2DutchOrder(
      getOrderInfo({
        swapper: SWAPPER,
      }),
      CHAIN_ID
    );
    const request = makeRequest({ encodedInnerOrder: order.serialize(), innerSig: '0x' });
    expect(request.protocol).toEqual(ProtocolVersion.V2);
  });

  it('exposes protocol v3 for Dutch_V3 orders', () => {
    const order = getV3Order(SWAPPER);
    const request = makeRequest(
      { encodedInnerOrder: order.serialize(), innerSig: '0x' },
      OrderType.Dutch_V3,
      V3_CHAIN_ID
    );
    expect(request.protocol).toEqual(ProtocolVersion.V3);
  });

  it('toCleanJSON sets protocol v3 for Dutch_V3 orders', () => {
    const order = getV3Order(SWAPPER);
    const request = makeRequest(
      { encodedInnerOrder: order.serialize(), innerSig: '0x' },
      OrderType.Dutch_V3,
      V3_CHAIN_ID
    );
    expect(request.toCleanJSON()).toEqual({
      tokenInChainId: V3_CHAIN_ID,
      tokenOutChainId: V3_CHAIN_ID,
      requestId: DERIVED_REQUEST_ID,
      quoteId: QUOTE_ID,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amount: RAW_AMOUNT.toString(),
      swapper: ethers.constants.AddressZero,
      type: 'EXACT_INPUT',
      numOutputs: 1,
      protocol: ProtocolVersion.V3,
    });
  });

  it('toOpposingCleanJSON sets protocol v3 for Dutch_V3 orders', () => {
    const order = getV3Order(SWAPPER);
    const request = makeRequest(
      { encodedInnerOrder: order.serialize(), innerSig: '0x' },
      OrderType.Dutch_V3,
      V3_CHAIN_ID
    );
    expect(request.toOpposingCleanJSON()).toEqual({
      tokenInChainId: V3_CHAIN_ID,
      tokenOutChainId: V3_CHAIN_ID,
      requestId: DERIVED_REQUEST_ID,
      quoteId: QUOTE_ID,
      tokenIn: TOKEN_OUT,
      tokenOut: TOKEN_IN,
      amount: RAW_AMOUNT.toString(),
      swapper: ethers.constants.AddressZero,
      type: 'EXACT_OUTPUT',
      numOutputs: 1,
      protocol: ProtocolVersion.V3,
    });
  });

  // Pins the tokenOutChainId getter, which previously returned the tokenIn chain id. Every
  // other fixture sets the two equal, so nothing else here distinguishes the fix from the bug.
  // Constructed directly because HardQuoteRequestBodyJoi pins tokenOutChainId to
  // Joi.ref('tokenInChainId'), so a validated request can never carry differing ids.
  it('reads tokenOutChainId from its own field', () => {
    const order = new UnsignedV2DutchOrder(
      getOrderInfo({
        swapper: SWAPPER,
      }),
      CHAIN_ID
    );
    const request = makeRequest({
      encodedInnerOrder: order.serialize(),
      innerSig: '0x',
      tokenOutChainId: 42161,
    });
    expect(request.tokenInChainId).toEqual(CHAIN_ID);
    expect(request.tokenOutChainId).toEqual(42161);
  });

  // Pins the requestId derivation directly, so the four toCleanJSON expectations above are not
  // the only thing standing between this contract and a silent change.
  it('derives requestId from quoteId, discarding the client requestId', () => {
    const order = new UnsignedV2DutchOrder(getOrderInfo({ swapper: SWAPPER }), CHAIN_ID);
    const request = makeRequest({ encodedInnerOrder: order.serialize(), innerSig: '0x' });
    expect(request.requestId).toEqual(QUOTE_ID);
    expect(request.requestId).not.toEqual(REQUEST_ID);
  });

  // The quoteId-absent branch falls back to a fresh uuidv4(). Characterization test: this
  // documents current behavior, it does not endorse it.
  it('with no quoteId, generates a requestId that is not the client requestId', () => {
    const order = new UnsignedV2DutchOrder(getOrderInfo({ swapper: SWAPPER }), CHAIN_ID);
    const request = makeRequest({ encodedInnerOrder: order.serialize(), innerSig: '0x', quoteId: undefined });
    expect(request.quoteId).toBeUndefined();
    expect(request.requestId).toEqual(expect.any(String));
    expect(request.requestId).not.toEqual(REQUEST_ID);
  });
});
