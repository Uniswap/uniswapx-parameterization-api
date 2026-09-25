import { ChainId, Token } from '@uniswap/sdk-core';
import {
  CosignedV3DutchOrder,
  UnsignedV3DutchOrder,
  UnsignedV3DutchOrderInfo,
  V3DutchOrderBuilder,
} from '@uniswap/uniswapx-sdk';
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';
import { BigNumber, ethers, Wallet } from 'ethers';
import { getV3BlockBuffer } from '../../../lib/constants';
import { ApiInjector } from '../../../lib/handlers/base/api-handler';
import {
  ContainerInjected,
  HardQuoteHandler,
  HardQuoteRequestBody,
  HardQuoteResponseData,
  RequestInjected,
} from '../../../lib/handlers/hard-quote';
import { MockQuoter, Quoter } from '../../../lib/quoters';
import { fakeContext, FakeCosigner, hardQuoteContainer } from '../../fakes';

const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
// Deliberately DIFFERENT from QUOTE_ID. HardQuoteRequest derives
// `requestId: _data.quoteId ?? uuidv4()`, so an assertion that the response echoes the
// requestId proves nothing while the two constants are the same uuid.
const REQUEST_ID = 'b45c2d1e-7f30-4a92-8c65-1d8e4f2a9b03';
// USDT and WBTC on Arbitrum One (previously borrowed from smart-order-router's token list).
const TOKEN_IN = new Token(ChainId.ARBITRUM_ONE, '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6, 'USDT', 'Tether USD');
const TOKEN_OUT = new Token(
  ChainId.ARBITRUM_ONE,
  '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  8,
  'WBTC',
  'Wrapped BTC'
);
const RAW_AMOUNT = BigNumber.from('1000000000000000000');
const CHAIN_ID = 42161;
// Arbitrary; the V3 path derives decayStartBlock from it, which the test asserts.
const CURRENT_BLOCK = 1_000_000;

const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

// Not exported: nothing outside this file uses it, and exporting a helper from a *.test.ts
// file is what lets a stray `.only` here silence an unrelated suite (see test/fixtures/hard-quote.ts).
const getPartialOrder = (data: Partial<UnsignedV3DutchOrderInfo>): UnsignedV3DutchOrder => {
  const now = Math.floor(new Date().getTime() / 1000);
  const validPartialOrder = new V3DutchOrderBuilder(CHAIN_ID)
    .cosigner(data.cosigner ?? ethers.constants.AddressZero)
    .deadline(now + 1000)
    .swapper(ethers.constants.AddressZero)
    .nonce(BigNumber.from(100))
    .startingBaseFee(BigNumber.from(0))
    .input({
      token: TOKEN_IN.address,
      startAmount: RAW_AMOUNT,
      curve: {
        relativeBlocks: [],
        relativeAmounts: [],
      },
      maxAmount: RAW_AMOUNT,
      adjustmentPerGweiBaseFee: BigNumber.from(0),
    })
    .output({
      token: TOKEN_OUT.address,
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

  return validPartialOrder;
};

// Mirrors makeProvider in handlerDutchV3.cosigner.test.ts. Only getBlockNumber is used by the
// V3 cosigner path (lib/handlers/hard-quote/handler.ts:277 and :418).
const makeProvider = (): ethers.providers.StaticJsonRpcProvider =>
  ({
    getBlockNumber: jest.fn().mockResolvedValue(CURRENT_BLOCK),
  } as unknown as ethers.providers.StaticJsonRpcProvider);

describe('Quote handler', () => {
  const swapperWallet = Wallet.createRandom();
  const cosignerWallet = Wallet.createRandom();

  const cosigner = new FakeCosigner(cosignerWallet);

  // Creating mocks for all the handler dependencies.
  const fakes = fakeContext('test');
  const requestInjectedMock: Promise<RequestInjected> = new Promise(
    (resolve) =>
      resolve({
        log: logger,
        requestId: 'test',
        ctx: fakes.ctx,
      }) as unknown as RequestInjected
  );

  const injectorPromiseMock = (
    quoters: Quoter[]
  ): Promise<ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>> =>
    new Promise((resolve) =>
      resolve({
        getContainerInjected: () =>
          hardQuoteContainer({
            quoters,
            // The V3 path calls provider.getBlockNumber() to derive decayStartBlock. A real
            // StaticJsonRpcProvider here defaults to http://localhost:8545, so the call fails
            // and the handler returns 500 -- which is why this suite was skipped rather than
            // being blocked on the order service. Duck-typed to keep the test offline.
            chainIdRpcMap: new Map([[CHAIN_ID, makeProvider()]]),
            cosignerFactory: cosigner.factory(),
          }),
        getRequestInjected: () => requestInjectedMock,
      } as unknown as ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>)
    );

  const getQuoteHandler = (quoters: Quoter[]) => new HardQuoteHandler('quote', injectorPromiseMock(quoters));

  const getEvent = (request: HardQuoteRequestBody): APIGatewayProxyEvent =>
    ({
      body: JSON.stringify(request),
    } as APIGatewayProxyEvent);

  const getRequest = async (order: UnsignedV3DutchOrder): Promise<HardQuoteRequestBody> => {
    const { types, domain, values } = order.permitData();
    const sig = await swapperWallet._signTypedData(domain, types, values);
    return {
      requestId: REQUEST_ID,
      quoteId: QUOTE_ID,
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      encodedInnerOrder: order.serialize(),
      innerSig: sig,
    };
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('Simple request and response', async () => {
    const quoters = [new MockQuoter(logger, 1, 1)];
    const request = await getRequest(getPartialOrder({ cosigner: cosignerWallet.address }));

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: HardQuoteResponseData = JSON.parse(response.body);
    expect(response.statusCode).toEqual(200);
    // requestId is the indicative quoteId, not the client-supplied requestId
    expect(quoteResponse.requestId).toEqual(QUOTE_ID);
    expect(quoteResponse.requestId).not.toEqual(REQUEST_ID);
    expect(quoteResponse.quoteId).toEqual(QUOTE_ID);
    expect(quoteResponse.chainId).toEqual(request.tokenInChainId);
    expect(quoteResponse.filler).toEqual(ethers.constants.AddressZero);
    const cosignedOrder = CosignedV3DutchOrder.parse(quoteResponse.encodedOrder, CHAIN_ID);

    // MockQuoter(1, 1) quotes exactly the requested amount, so the quote is not strictly
    // better for the swapper and nothing is overridden.
    expect(cosignedOrder.info.cosignerData.exclusiveFiller).toEqual(ethers.constants.AddressZero);
    expect(cosignedOrder.info.cosignerData.inputOverride).toEqual(BigNumber.from(0));
    expect(cosignedOrder.info.cosignerData.outputOverrides.length).toEqual(1);
    expect(cosignedOrder.info.cosignerData.outputOverrides[0]).toEqual(BigNumber.from(0));

    // V3-specific: decay is block-based, derived from the mocked getBlockNumber. Without this
    // the mocked provider would be untested scaffolding.
    expect(cosignedOrder.info.cosignerData.decayStartBlock).toEqual(CURRENT_BLOCK + getV3BlockBuffer(CHAIN_ID));
    // V3 uses a tighter exclusivity override than V2's 100 bps.
    expect(cosignedOrder.info.cosignerData.exclusivityOverrideBps).toEqual(BigNumber.from(25));
  });
});
