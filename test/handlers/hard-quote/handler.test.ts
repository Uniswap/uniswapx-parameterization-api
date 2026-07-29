import { KMSClient } from '@aws-sdk/client-kms';
import { TradeType } from '@uniswap/sdk-core';
import { CosignedV2DutchOrder, CosignerData, OrderType, UnsignedV2DutchOrder } from '@uniswap/uniswapx-sdk';
import { createMetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
// import axios from 'axios';
import { default as Logger } from 'bunyan';
import { BigNumber, ethers, Wallet } from 'ethers';

import { KmsSigner } from '@uniswap/signer';
import { HardQuoteRequest, QuoteResponse, QuoteResponseData } from '../../../lib/entities';
import { AWSMetricsLogger } from '../../../lib/entities/aws-metrics-logger';
import { ApiInjector } from '../../../lib/handlers/base/api-handler';
import {
  ContainerInjected,
  HardQuoteHandler,
  HardQuoteRequestBody,
  HardQuoteResponseData,
  RequestInjected,
} from '../../../lib/handlers/hard-quote';
import { getCosignerData } from '../../../lib/handlers/hard-quote/handler';
import { MockOrderServiceProvider } from '../../../lib/providers';
import { MockQuoter, MOCK_FILLER_ADDRESS, Quoter } from '../../../lib/quoters';
import { getOrder } from '../../fixtures/hard-quote';

jest.mock('axios');
jest.mock('@aws-sdk/client-kms');
jest.mock('@uniswap/signer');

const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
// Deliberately DIFFERENT from QUOTE_ID. These were the same uuid, which made every
// requestId assertion below hold no matter which of the two ids the handler echoed.
const REQUEST_ID = 'b45c2d1e-7f30-4a92-8c65-1d8e4f2a9b03';
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const RAW_AMOUNT = BigNumber.from('1000000000000000000');
const CHAIN_ID = 1;

// silent logger in tests
const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

process.env.KMS_KEY_ID = 'test-key-id';
process.env.REGION = 'us-east-2';

describe('Quote handler', () => {
  const swapperWallet = Wallet.createRandom();
  const cosignerWallet = Wallet.createRandom();

  const mockGetAddress = jest.fn().mockResolvedValue(cosignerWallet.address);
  const mockSignDigest = jest
    .fn()
    .mockImplementation((digest) => cosignerWallet.signMessage(ethers.utils.arrayify(digest)));

  (KmsSigner as jest.Mock).mockImplementation(() => ({
    getAddress: mockGetAddress,
    signDigest: mockSignDigest,
  }));
  (KMSClient as jest.Mock).mockImplementation(() => jest.fn());

  // Creating mocks for all the handler dependencies.
  const requestInjectedMock: Promise<RequestInjected> = new Promise(
    (resolve) =>
      resolve({
        log: logger,
        requestId: 'test',
        metric: new AWSMetricsLogger(createMetricsLogger()),
      }) as unknown as RequestInjected
  );

  const injectorPromiseMock = (
    quoters: Quoter[]
  ): Promise<ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>> =>
    new Promise((resolve) =>
      resolve({
        getContainerInjected: () => {
          return {
            quoters,
            orderServiceProvider: new MockOrderServiceProvider(),
            // Mock chainIdRpcMap
            chainIdRpcMap: new Map([[42161, new ethers.providers.StaticJsonRpcProvider()]]),
          };
        },
        getRequestInjected: () => requestInjectedMock,
      } as unknown as ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>)
    );

  const getQuoteHandler = (quoters: Quoter[]) => new HardQuoteHandler('quote', injectorPromiseMock(quoters));

  const getEvent = (request: HardQuoteRequestBody): APIGatewayProxyEvent =>
    ({
      body: JSON.stringify(request),
    } as APIGatewayProxyEvent);

  const getRequest = async (
    order: UnsignedV2DutchOrder,
    // `null` omits quoteId from the body. An explicit `undefined` would re-trigger the
    // default, silently testing the quoteId-present path instead.
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

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('Simple request and response', async () => {
    const quoters = [new MockQuoter(logger, 1, 1)];
    const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: HardQuoteResponseData = JSON.parse(response.body); // random quoteId
    expect(response.statusCode).toEqual(200);
    expect(quoteResponse.requestId).toEqual(request.quoteId);
    expect(quoteResponse.quoteId).toEqual(request.quoteId);
    expect(quoteResponse.chainId).toEqual(request.tokenInChainId);
    expect(quoteResponse.filler).toEqual(ethers.constants.AddressZero);
    const cosignedOrder = CosignedV2DutchOrder.parse(quoteResponse.encodedOrder, CHAIN_ID);

    // no overrides since quote was same as request
    expect(cosignedOrder.info.cosignerData.exclusiveFiller).toEqual(ethers.constants.AddressZero);
    expect(cosignedOrder.info.cosignerData.inputOverride).toEqual(BigNumber.from(0));
    expect(cosignedOrder.info.cosignerData.outputOverrides.length).toEqual(1);
    expect(cosignedOrder.info.cosignerData.outputOverrides[0]).toEqual(BigNumber.from(0));
  });

  it('Pick the greater of two quotes - EXACT_IN', async () => {
    const quoters = [new MockQuoter(logger, 1, 1), new MockQuoter(logger, 2, 1)];
    const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: HardQuoteResponseData = JSON.parse(response.body); // random quoteId
    expect(response.statusCode).toEqual(200);
    expect(quoteResponse.requestId).toEqual(request.quoteId);
    expect(quoteResponse.quoteId).toEqual(request.quoteId);
    expect(quoteResponse.chainId).toEqual(request.tokenInChainId);
    expect(quoteResponse.filler).toEqual(MOCK_FILLER_ADDRESS);
    const cosignedOrder = CosignedV2DutchOrder.parse(quoteResponse.encodedOrder, CHAIN_ID);
    expect(cosignedOrder.info.cosignerData.exclusiveFiller).toEqual(MOCK_FILLER_ADDRESS);

    // overridden output amount to 2x
    expect(cosignedOrder.info.cosignerData.inputOverride).toEqual(BigNumber.from(0));
    expect(cosignedOrder.info.cosignerData.outputOverrides.length).toEqual(1);
    expect(cosignedOrder.info.cosignerData.outputOverrides[0]).toEqual(RAW_AMOUNT.mul(2));
  });

  it('Pick the lesser of two quotes - EXACT_OUT', async () => {
    const quoters = [new MockQuoter(logger, 9, 10), new MockQuoter(logger, 8, 10)];
    const order = getOrder({
      cosigner: cosignerWallet.address,
      input: {
        token: TOKEN_IN,
        startAmount: RAW_AMOUNT,
        endAmount: RAW_AMOUNT.mul(110).div(100),
      },
      outputs: [
        {
          token: TOKEN_OUT,
          startAmount: RAW_AMOUNT,
          endAmount: RAW_AMOUNT,
          recipient: ethers.constants.AddressZero,
        },
      ],
    });
    const request = await getRequest(order);

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: HardQuoteResponseData = JSON.parse(response.body); // random quoteId
    expect(response.statusCode).toEqual(200);
    expect(quoteResponse.requestId).toEqual(request.quoteId);
    expect(quoteResponse.quoteId).toEqual(request.quoteId);
    expect(quoteResponse.chainId).toEqual(request.tokenInChainId);
    expect(quoteResponse.filler).toEqual(MOCK_FILLER_ADDRESS);
    const cosignedOrder = CosignedV2DutchOrder.parse(quoteResponse.encodedOrder, CHAIN_ID);
    expect(cosignedOrder.info.cosignerData.exclusiveFiller).toEqual(MOCK_FILLER_ADDRESS);

    // overridden output amount to 2x
    expect(cosignedOrder.info.cosignerData.inputOverride).toEqual(RAW_AMOUNT.mul(8).div(10));
    expect(cosignedOrder.info.cosignerData.outputOverrides.length).toEqual(1);
    expect(cosignedOrder.info.cosignerData.outputOverrides[0]).toEqual(BigNumber.from(0));
  });

  it('Two quoters returning the same result', async () => {
    const quoters = [new MockQuoter(logger, 1, 1), new MockQuoter(logger, 1, 1)];
    const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: HardQuoteResponseData = JSON.parse(response.body); // random quoteId
    expect(response.statusCode).toEqual(200);
    expect(quoteResponse.requestId).toEqual(request.quoteId);
    expect(quoteResponse.quoteId).toEqual(request.quoteId);
    expect(quoteResponse.chainId).toEqual(request.tokenInChainId);
    expect(quoteResponse.filler).toEqual(ethers.constants.AddressZero);
    const cosignedOrder = CosignedV2DutchOrder.parse(quoteResponse.encodedOrder, CHAIN_ID);
    expect(cosignedOrder.info.cosignerData.exclusiveFiller).toEqual(ethers.constants.AddressZero);

    // overridden output amount to 2x
    expect(cosignedOrder.info.cosignerData.inputOverride).toEqual(BigNumber.from(0));
    expect(cosignedOrder.info.cosignerData.outputOverrides.length).toEqual(1);
    expect(cosignedOrder.info.cosignerData.outputOverrides[0]).toEqual(BigNumber.from(0));
  });

  it('Unknown cosigner', async () => {
    const quoters = [new MockQuoter(logger, 1, 1)];
    const request = await getRequest(getOrder({ cosigner: '0x1111111111111111111111111111111111111111' }));

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    expect(response.statusCode).toEqual(400);
    const error = JSON.parse(response.body);
    expect(error).toMatchObject({
      detail: 'Unknown cosigner',
      errorCode: 'QUOTE_ERROR',
    });
  });

  // Pins the requestId contract introduced by e542951 (PR #317): HardQuoteRequest's
  // constructor sets `requestId: _data.quoteId ?? uuidv4()`, so the response echoes the
  // indicative quoteId and the client-supplied requestId is discarded. This is deliberate --
  // `hardrequests` has no quoteId column, so requestId is how the indicative quoteId reaches
  // Redshift. The `.not.toEqual` is the load-bearing line: it fails if the derivation is
  // removed without updating this test.
  it('echoes the indicative quoteId as requestId, discarding the client requestId', async () => {
    const quoters = [new MockQuoter(logger, 1, 1)];
    const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));
    expect(request.requestId).toEqual(REQUEST_ID);
    expect(request.quoteId).toEqual(QUOTE_ID);

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: HardQuoteResponseData = JSON.parse(response.body);
    expect(response.statusCode).toEqual(200);
    expect(quoteResponse.requestId).toEqual(QUOTE_ID);
    expect(quoteResponse.requestId).not.toEqual(REQUEST_ID);
    expect(quoteResponse.quoteId).toEqual(QUOTE_ID);
  });

  // quoteId is optional in HardQuoteRequestBodyJoi, and on that branch the derivation falls
  // back to a fresh uuidv4(). The caller therefore gets back a requestId it has never seen.
  // Characterization test: this documents current behavior, it does not endorse it.
  // See the follow-up ticket on the requestId contract.
  it('with no quoteId, returns a generated requestId that is neither id the caller sent', async () => {
    const quoters = [new MockQuoter(logger, 1, 1)];
    const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }), null);
    expect(request.quoteId).toBeUndefined();

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: HardQuoteResponseData = JSON.parse(response.body);
    expect(response.statusCode).toEqual(200);
    expect(quoteResponse.requestId).toEqual(expect.any(String));
    expect(quoteResponse.requestId).not.toEqual(REQUEST_ID);
    expect(quoteResponse.requestId).not.toEqual(QUOTE_ID);
  });

  it('No quotes', async () => {
    const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));

    const response: APIGatewayProxyResult = await getQuoteHandler([]).handler(
      getEvent(request),
      {} as unknown as Context
    );
    expect(response.statusCode).toEqual(404);
    const error = JSON.parse(response.body);
    expect(error).toMatchObject({
      detail: 'No quotes available',
      errorCode: 'QUOTE_ERROR',
    });
  });

  describe('getCosignerData', () => {
    const getQuoteResponse = (
      data: Partial<QuoteResponseData>,
      type: TradeType = TradeType.EXACT_INPUT
    ): QuoteResponse => {
      return new QuoteResponse(
        Object.assign(
          {
            chainId: CHAIN_ID,
            amountOut: ethers.utils.parseEther('1'),
            amountIn: ethers.utils.parseEther('1'),
            quoteId: QUOTE_ID,
            requestId: REQUEST_ID,
            filler: MOCK_FILLER_ADDRESS,
            swapper: swapperWallet.address,
            tokenIn: TOKEN_IN,
            tokenOut: TOKEN_OUT,
          },
          data
        ),
        type,
        { fillerName: 'mock', endpoint: 'mock' }
      );
    };

    it('updates decay times reasonably', async () => {
      const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));
      const now = Math.floor(Date.now() / 1000);
      const cosignerData: CosignerData = (await getCosignerData(
        new HardQuoteRequest(request, OrderType.Dutch_V2),
        getQuoteResponse({}),
        OrderType.Dutch_V2
      )) as CosignerData;
      expect(cosignerData.decayStartTime).toBeGreaterThan(now);
      expect(cosignerData.decayStartTime).toBeLessThan(now + 1000);
      expect(cosignerData.decayEndTime).toBeGreaterThan(cosignerData.decayStartTime);
      expect(cosignerData.decayEndTime).toBeLessThan(cosignerData.decayStartTime + 1000);
    });

    // getCosignerData branches on `request.type`, which HardQuoteRequest derives from the
    // ORDER's input curve (startAmount == endAmount => EXACT_INPUT). It does NOT read the
    // TradeType passed to `getQuoteResponse`. getOrder()'s default input is non-decaying, so
    // an exact-output case needs an input-decaying order -- same shape as
    // 'Pick the lesser of two quotes - EXACT_OUT' above.
    const getExactOutputRequest = (): Promise<HardQuoteRequestBody> =>
      getRequest(
        getOrder({
          cosigner: cosignerWallet.address,
          input: {
            token: TOKEN_IN,
            startAmount: RAW_AMOUNT,
            endAmount: RAW_AMOUNT.mul(110).div(100),
          },
          outputs: [
            {
              token: TOKEN_OUT,
              startAmount: RAW_AMOUNT,
              endAmount: RAW_AMOUNT,
              recipient: ethers.constants.AddressZero,
            },
          ],
        })
      );

    it('exact input quote worse, no exclusivity', async () => {
      const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));
      const hardRequest = new HardQuoteRequest(request, OrderType.Dutch_V2);
      // guards against the fixture silently drifting to the other branch
      expect(hardRequest.type).toEqual(TradeType.EXACT_INPUT);
      const cosignerData = (await getCosignerData(
        hardRequest,
        // amountOut (0.8) is not greater than totalOutputAmountStart (1.0)
        getQuoteResponse({ amountOut: ethers.utils.parseEther('0.8') }),
        OrderType.Dutch_V2
      )) as CosignerData;
      expect(cosignerData.exclusiveFiller).toEqual(ethers.constants.AddressZero);
      expect(cosignerData.inputOverride).toEqual(BigNumber.from(0));
      expect(cosignerData.outputOverrides.length).toEqual(1);
      expect(cosignerData.outputOverrides[0]).toEqual(BigNumber.from(0));
    });

    it('exact input quote better, sets exclusivity and updates amounts', async () => {
      const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));
      const hardRequest = new HardQuoteRequest(request, OrderType.Dutch_V2);
      expect(hardRequest.type).toEqual(TradeType.EXACT_INPUT);
      const outputAmount = ethers.utils.parseEther('2');
      const cosignerData = (await getCosignerData(
        hardRequest,
        // amountOut (2.0) > totalOutputAmountStart (1.0): the whole increase goes to outputs[0]
        getQuoteResponse({ amountOut: outputAmount }),
        OrderType.Dutch_V2
      )) as CosignerData;
      expect(cosignerData.exclusiveFiller).toEqual(MOCK_FILLER_ADDRESS);
      expect(cosignerData.inputOverride).toEqual(BigNumber.from(0));
      expect(cosignerData.outputOverrides.length).toEqual(1);
      expect(cosignerData.outputOverrides[0]).toEqual(outputAmount);
    });

    it('exact input quote better, multi-output: entire increase goes to outputs[0]', async () => {
      const request = await getRequest(
        getOrder({
          cosigner: cosignerWallet.address,
          outputs: [
            {
              token: TOKEN_OUT,
              startAmount: RAW_AMOUNT,
              endAmount: RAW_AMOUNT.mul(90).div(100),
              recipient: ethers.constants.AddressZero,
            },
            {
              token: TOKEN_OUT,
              startAmount: RAW_AMOUNT.mul(10).div(100),
              endAmount: RAW_AMOUNT.mul(9).div(100),
              recipient: '0x1111111111111111111111111111111111111111',
            },
          ],
        })
      );
      const hardRequest = new HardQuoteRequest(request, OrderType.Dutch_V2);
      expect(hardRequest.type).toEqual(TradeType.EXACT_INPUT);
      // totalOutputAmountStart is the SUM of all outputs (1.0 + 0.1)
      expect(hardRequest.totalOutputAmountStart).toEqual(ethers.utils.parseEther('1.1'));
      const cosignerData = (await getCosignerData(
        hardRequest,
        getQuoteResponse({ amountOut: ethers.utils.parseEther('1.5') }),
        OrderType.Dutch_V2
      )) as CosignerData;
      expect(cosignerData.exclusiveFiller).toEqual(MOCK_FILLER_ADDRESS);
      expect(cosignerData.inputOverride).toEqual(BigNumber.from(0));
      expect(cosignerData.outputOverrides.length).toEqual(2);
      // outputs[0].startAmount (1.0) + increase (1.5 - 1.1 = 0.4); measured against the SUM
      // but added to outputs[0] only
      expect(cosignerData.outputOverrides[0]).toEqual(ethers.utils.parseEther('1.4'));
      // the fee output is left at 0, i.e. "use the order's own amount"
      expect(cosignerData.outputOverrides[1]).toEqual(BigNumber.from(0));
    });

    it('exact output quote worse, no exclusivity', async () => {
      const request = await getExactOutputRequest();
      const hardRequest = new HardQuoteRequest(request, OrderType.Dutch_V2);
      expect(hardRequest.type).toEqual(TradeType.EXACT_OUTPUT);
      const cosignerData = (await getCosignerData(
        hardRequest,
        // amountIn (1.2) is not less than totalInputAmountStart (1.0)
        getQuoteResponse({ amountIn: ethers.utils.parseEther('1.2') }, TradeType.EXACT_OUTPUT),
        OrderType.Dutch_V2
      )) as CosignerData;
      expect(cosignerData.exclusiveFiller).toEqual(ethers.constants.AddressZero);
      expect(cosignerData.inputOverride).toEqual(BigNumber.from(0));
      expect(cosignerData.outputOverrides.length).toEqual(1);
      expect(cosignerData.outputOverrides[0]).toEqual(BigNumber.from(0));
    });

    it('exact output quote better, sets exclusivity and updates amounts', async () => {
      const request = await getExactOutputRequest();
      const hardRequest = new HardQuoteRequest(request, OrderType.Dutch_V2);
      expect(hardRequest.type).toEqual(TradeType.EXACT_OUTPUT);
      const inputOverride = ethers.utils.parseEther('0.8');
      const cosignerData = (await getCosignerData(
        hardRequest,
        // amountIn (0.8) < totalInputAmountStart (1.0): the swapper pays less
        getQuoteResponse({ amountIn: inputOverride }, TradeType.EXACT_OUTPUT),
        OrderType.Dutch_V2
      )) as CosignerData;
      expect(cosignerData.exclusiveFiller).toEqual(MOCK_FILLER_ADDRESS);
      expect(cosignerData.inputOverride).toEqual(inputOverride);
      expect(cosignerData.outputOverrides.length).toEqual(1);
      expect(cosignerData.outputOverrides[0]).toEqual(BigNumber.from(0));
    });

    it('unsupported order type throws', async () => {
      const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));
      await expect(
        getCosignerData(new HardQuoteRequest(request, OrderType.Dutch_V2), getQuoteResponse({}), OrderType.Dutch)
      ).rejects.toThrow('Unsupported order type');
    });
  });
});
