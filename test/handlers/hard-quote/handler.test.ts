import { TradeType } from '@uniswap/sdk-core';
import { CosignedV2DutchOrder, UnsignedV2DutchOrder, UnsignedV2DutchOrderInfo } from '@uniswap/uniswapx-sdk';
import { createMetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
// import axios from 'axios';
import { default as Logger } from 'bunyan';
import { BigNumber, ethers, Wallet } from 'ethers';

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

jest.mock('axios');

const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const RAW_AMOUNT = BigNumber.from('1000000000000000000');
const CHAIN_ID = 1;

// silent logger in tests
const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

export const getOrder = (data: Partial<UnsignedV2DutchOrderInfo>): UnsignedV2DutchOrder => {
  const now = Math.floor(new Date().getTime() / 1000);
  return new UnsignedV2DutchOrder(
    Object.assign(
      {
        deadline: now + 1000,
        reactor: ethers.constants.AddressZero,
        swapper: ethers.constants.AddressZero,
        nonce: BigNumber.from(10),
        additionalValidationContract: ethers.constants.AddressZero,
        additionalValidationData: '0x',
        cosigner: ethers.constants.AddressZero,
        cosignerData: undefined,
        baseInput: {
          token: TOKEN_IN,
          startAmount: RAW_AMOUNT,
          endAmount: RAW_AMOUNT,
        },
        baseOutputs: [
          {
            token: TOKEN_OUT,
            startAmount: RAW_AMOUNT,
            endAmount: RAW_AMOUNT.mul(90).div(100),
            recipient: ethers.constants.AddressZero,
          },
        ],
        cosignature: undefined,
      },
      data
    ),
    CHAIN_ID
  );
};

describe('Quote handler', () => {
  const swapperWallet = Wallet.createRandom();
  const cosignerWallet = Wallet.createRandom();

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
            cosigner: cosignerWallet._signingKey(),
            cosignerAddress: cosignerWallet.address,
            orderServiceProvider: new MockOrderServiceProvider(),
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

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('Simple request and response', async () => {
    const quoters = [new MockQuoter(logger, 1, 1)];
    const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));
    console.log(request);

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: HardQuoteResponseData = JSON.parse(response.body); // random quoteId
    expect(response.statusCode).toEqual(200);
    expect(quoteResponse.requestId).toEqual(request.requestId);
    expect(quoteResponse.quoteId).toEqual(request.quoteId);
    expect(quoteResponse.chainId).toEqual(request.tokenInChainId);
    expect(quoteResponse.filler).toEqual(ethers.constants.AddressZero);
    const cosignedOrder = CosignedV2DutchOrder.parse(quoteResponse.encodedOrder, CHAIN_ID);

    // no overrides since quote was same as request
    expect(cosignedOrder.info.cosignerData.exclusiveFiller).toEqual(ethers.constants.AddressZero);
    expect(cosignedOrder.info.cosignerData.inputAmount).toEqual(BigNumber.from(0));
    expect(cosignedOrder.info.cosignerData.outputAmounts.length).toEqual(1);
    expect(cosignedOrder.info.cosignerData.outputAmounts[0]).toEqual(BigNumber.from(0));
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
    expect(quoteResponse.requestId).toEqual(request.requestId);
    expect(quoteResponse.quoteId).toEqual(request.quoteId);
    expect(quoteResponse.chainId).toEqual(request.tokenInChainId);
    expect(quoteResponse.filler).toEqual(MOCK_FILLER_ADDRESS);
    const cosignedOrder = CosignedV2DutchOrder.parse(quoteResponse.encodedOrder, CHAIN_ID);
    expect(cosignedOrder.info.cosignerData.exclusiveFiller).toEqual(MOCK_FILLER_ADDRESS);

    // overridden output amount to 2x
    expect(cosignedOrder.info.cosignerData.inputAmount).toEqual(BigNumber.from(0));
    expect(cosignedOrder.info.cosignerData.outputAmounts.length).toEqual(1);
    expect(cosignedOrder.info.cosignerData.outputAmounts[0]).toEqual(RAW_AMOUNT.mul(2));
  });

  it('Pick the lesser of two quotes - EXACT_OUT', async () => {
    const quoters = [new MockQuoter(logger, 9, 10), new MockQuoter(logger, 8, 10)];
    const order = getOrder({
      cosigner: cosignerWallet.address,
      baseInput: {
        token: TOKEN_IN,
        startAmount: RAW_AMOUNT,
        endAmount: RAW_AMOUNT.mul(110).div(100),
      },
      baseOutputs: [
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
    expect(quoteResponse.requestId).toEqual(request.requestId);
    expect(quoteResponse.quoteId).toEqual(request.quoteId);
    expect(quoteResponse.chainId).toEqual(request.tokenInChainId);
    expect(quoteResponse.filler).toEqual(MOCK_FILLER_ADDRESS);
    const cosignedOrder = CosignedV2DutchOrder.parse(quoteResponse.encodedOrder, CHAIN_ID);
    expect(cosignedOrder.info.cosignerData.exclusiveFiller).toEqual(MOCK_FILLER_ADDRESS);

    // overridden output amount to 2x
    expect(cosignedOrder.info.cosignerData.inputAmount).toEqual(RAW_AMOUNT.mul(8).div(10));
    expect(cosignedOrder.info.cosignerData.outputAmounts.length).toEqual(1);
    expect(cosignedOrder.info.cosignerData.outputAmounts[0]).toEqual(BigNumber.from(0));
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
    expect(quoteResponse.requestId).toEqual(request.requestId);
    expect(quoteResponse.quoteId).toEqual(request.quoteId);
    expect(quoteResponse.chainId).toEqual(request.tokenInChainId);
    expect(quoteResponse.filler).toEqual(ethers.constants.AddressZero);
    const cosignedOrder = CosignedV2DutchOrder.parse(quoteResponse.encodedOrder, CHAIN_ID);
    expect(cosignedOrder.info.cosignerData.exclusiveFiller).toEqual(ethers.constants.AddressZero);

    // overridden output amount to 2x
    expect(cosignedOrder.info.cosignerData.inputAmount).toEqual(BigNumber.from(0));
    expect(cosignedOrder.info.cosignerData.outputAmounts.length).toEqual(1);
    expect(cosignedOrder.info.cosignerData.outputAmounts[0]).toEqual(BigNumber.from(0));
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
        type
      );
    };

    it('updates decay times reasonably', async () => {
      const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));
      const now = Math.floor(Date.now() / 1000);
      const cosignerData = getCosignerData(new HardQuoteRequest(request), getQuoteResponse({}));
      expect(cosignerData.decayStartTime).toBeGreaterThan(now);
      expect(cosignerData.decayStartTime).toBeLessThan(now + 1000);
      expect(cosignerData.decayEndTime).toBeGreaterThan(cosignerData.decayStartTime);
      expect(cosignerData.decayEndTime).toBeLessThan(cosignerData.decayStartTime + 1000);
    });

    it('exact input quote worse, no exclusivity', async () => {
      const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));
      const cosignerData = getCosignerData(
        new HardQuoteRequest(request),
        getQuoteResponse({ amountOut: ethers.utils.parseEther('0.8') })
      );
      expect(cosignerData.exclusiveFiller).toEqual(ethers.constants.AddressZero);
      expect(cosignerData.inputAmount).toEqual(BigNumber.from(0));
      expect(cosignerData.outputAmounts.length).toEqual(1);
      expect(cosignerData.outputAmounts[0]).toEqual(BigNumber.from(0));
    });

    it('exact input quote better, sets exclusivity and updates amounts', async () => {
      const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));
      const outputAmount = ethers.utils.parseEther('2');
      const cosignerData = getCosignerData(
        new HardQuoteRequest(request),
        getQuoteResponse({ amountOut: outputAmount })
      );
      expect(cosignerData.exclusiveFiller).toEqual(MOCK_FILLER_ADDRESS);
      expect(cosignerData.inputAmount).toEqual(BigNumber.from(0));
      expect(cosignerData.outputAmounts.length).toEqual(1);
      expect(cosignerData.outputAmounts[0]).toEqual(outputAmount);
    });

    it('exact output quote worse, no exclusivity', async () => {
      const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));
      const cosignerData = getCosignerData(
        new HardQuoteRequest(request),
        getQuoteResponse({ amountIn: ethers.utils.parseEther('1.2') }, TradeType.EXACT_OUTPUT)
      );
      expect(cosignerData.exclusiveFiller).toEqual(ethers.constants.AddressZero);
      expect(cosignerData.inputAmount).toEqual(BigNumber.from(0));
      expect(cosignerData.outputAmounts.length).toEqual(1);
      expect(cosignerData.outputAmounts[0]).toEqual(BigNumber.from(0));
    });

    it('exact input quote better, sets exclusivity and updates amounts', async () => {
      const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));
      const inputAmount = ethers.utils.parseEther('0.8');
      const cosignerData = getCosignerData(
        new HardQuoteRequest(request),
        getQuoteResponse({ amountIn: ethers.utils.parseEther('1.2') }, TradeType.EXACT_OUTPUT)
      );
      expect(cosignerData.exclusiveFiller).toEqual(MOCK_FILLER_ADDRESS);
      expect(cosignerData.inputAmount).toEqual(inputAmount);
      expect(cosignerData.outputAmounts.length).toEqual(1);
      expect(cosignerData.outputAmounts[0]).toEqual(BigNumber.from(0));
    });
  });
});
