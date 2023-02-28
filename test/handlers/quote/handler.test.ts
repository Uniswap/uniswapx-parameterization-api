import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import axios from 'axios';
import { default as Logger } from 'bunyan';
import { ethers } from 'ethers';

import { ApiInjector, ApiRInj } from '../../../lib/handlers/base/api-handler';
import { ContainerInjected, PostQuoteRequestBody, PostQuoteResponse } from '../../../lib/handlers/quote';
import { QuoteHandler } from '../../../lib/handlers/quote/handler';
import { MockWebhookConfigurationProvider } from '../../../lib/providers';
import { MockQuoter, MOCK_FILLER_ADDRESS, Quoter, WebhookQuoter } from '../../../lib/quoters';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const OFFERER = '0x0000000000000000000000000000000000000000';
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CHAIN_ID = 1;

// silent logger in tests
const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

describe('Quote handler', () => {
  // Creating mocks for all the handler dependencies.
  const requestInjectedMock: Promise<ApiRInj> = new Promise(
    (resolve) =>
      resolve({
        log: logger,
        requestId: 'test',
      }) as unknown as ApiRInj
  );

  const injectorPromiseMock = (
    quoters: Quoter[]
  ): Promise<ApiInjector<ContainerInjected, ApiRInj, PostQuoteRequestBody, void>> =>
    new Promise((resolve) =>
      resolve({
        getContainerInjected: () => {
          return {
            quoters,
          };
        },
        getRequestInjected: () => requestInjectedMock,
      } as unknown as ApiInjector<ContainerInjected, ApiRInj, PostQuoteRequestBody, void>)
    );

  const getQuoteHandler = (quoters: Quoter[]) => new QuoteHandler('quote', injectorPromiseMock(quoters));

  const getEvent = (request: PostQuoteRequestBody): APIGatewayProxyEvent =>
    ({
      body: JSON.stringify(request),
    } as APIGatewayProxyEvent);

  const getRequest = (amountIn: string): PostQuoteRequestBody => ({
    requestId: REQUEST_ID,
    tokenInChainId: CHAIN_ID,
    tokenOutChainId: CHAIN_ID,
    offerer: OFFERER,
    tokenIn: TOKEN_IN,
    amount: amountIn,
    tokenOut: TOKEN_OUT,
    type: 'EXACT_INPUT',
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const responseFromRequest = (
    request: PostQuoteRequestBody,
    overrides: Partial<PostQuoteResponse>
  ): PostQuoteResponse => {
    return Object.assign(
      {},
      {
        amountOut: request.amount,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.amount,
        offerer: request.offerer,
        requestId: request.requestId,
        chainId: request.tokenInChainId,
        filler: MOCK_FILLER_ADDRESS,
        quoteId: QUOTE_ID,
      },
      overrides
    );
  };

  it('Simple request and response', async () => {
    const quoters = [new MockQuoter(logger, 1, 1)];
    const amountIn = ethers.utils.parseEther('1');
    const request = getRequest(amountIn.toString());

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: PostQuoteResponse = JSON.parse(response.body); // random quoteId
    expect(response.statusCode).toEqual(200);
    expect(responseFromRequest(request, {})).toMatchObject({ ...quoteResponse, quoteId: expect.any(String) });
  });

  it('Handles hex amount', async () => {
    const quoters = [new MockQuoter(logger, 1, 1)];
    const amountIn = ethers.utils.parseEther('1');
    const request = getRequest(amountIn.toHexString());

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: PostQuoteResponse = JSON.parse(response.body); // random quoteId
    expect(response.statusCode).toEqual(200);
    expect(
      responseFromRequest(request, { amountIn: amountIn.toString(), amountOut: amountIn.toString() })
    ).toMatchObject({ ...quoteResponse, quoteId: expect.any(String) });
  });

  it('Pick the greater of two quotes', async () => {
    const quoters = [new MockQuoter(logger, 1, 1), new MockQuoter(logger, 2, 1)];
    const amountIn = ethers.utils.parseEther('1');
    const request = getRequest(amountIn.toString());

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: PostQuoteResponse = JSON.parse(response.body); // random quoteId
    expect(response.statusCode).toEqual(200);
    expect(responseFromRequest(request, { amountOut: amountIn.mul(2).toString() })).toMatchObject({
      ...quoteResponse,
      quoteId: expect.any(String),
    });
  });

  it('Two quoters returning the same result', async () => {
    const quoters = [new MockQuoter(logger, 1, 1), new MockQuoter(logger, 1, 1)];
    const amountIn = ethers.utils.parseEther('1');
    const request = getRequest(amountIn.toString());

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: PostQuoteResponse = JSON.parse(response.body); // random quoteId
    expect(response.statusCode).toEqual(200);
    expect(responseFromRequest(request, {})).toMatchObject({ ...quoteResponse, quoteId: expect.any(String) });
  });

  it('Invalid amountIn', async () => {
    const invalidAmounts = ['-100', 'aszzz', 'zz'];

    const quoters = [new MockQuoter(logger, 1, 1)];

    for (const amount of invalidAmounts) {
      const request = getRequest(amount);

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      const error = JSON.parse(response.body);
      expect(response.statusCode).toEqual(400);
      expect(error).toMatchObject({
        detail: 'Invalid amount',
        errorCode: 'VALIDATION_ERROR',
      });
    }
  });

  describe('Webhook Quoter', () => {
    it('Simple request and response', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([{ endpoint: 'https://uniswap.org', headers: {} }]);
      const quoters = [new WebhookQuoter(logger, webhookProvider)];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: {
            amountOut: amountIn.mul(2).toString(),
            requestId: request.requestId,
            tokenIn: request.tokenIn,
            tokenOut: request.tokenOut,
            amountIn: request.amount,
            offerer: request.offerer,
            chainId: request.tokenInChainId,
            quoteId: QUOTE_ID,
          },
        });
      });

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      const quoteResponse: PostQuoteResponse = JSON.parse(response.body);
      expect(response.statusCode).toEqual(200);
      expect(quoteResponse).toMatchObject({
        amountOut: amountIn.mul(2).toString(),
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.amount,
        offerer: request.offerer,
        chainId: request.tokenInChainId,
        requestId: request.requestId,
        quoteId: expect.any(String),
      });
    });

    it('Passes headers', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([
        {
          endpoint: 'https://uniswap.org',
          headers: {
            'X-Authentication': '1234',
          },
        },
      ]);
      const quoters = [new WebhookQuoter(logger, webhookProvider)];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      mockedAxios.post.mockImplementationOnce((_endpoint, _req, options: any) => {
        expect(options.headers['X-Authentication']).toEqual('1234');
        return Promise.resolve({
          data: {
            ...responseFromRequest(request, { amountOut: amountIn.mul(2).toString() }),
          },
        });
      });

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      const quoteResponse: PostQuoteResponse = JSON.parse(response.body);
      expect(response.statusCode).toEqual(200);
      expect(quoteResponse).toMatchObject({
        amountOut: amountIn.mul(2).toString(),
        amountIn: request.amount,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        chainId: request.tokenInChainId,
        offerer: request.offerer,
      });
    });

    it('handles invalid responses', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([{ endpoint: 'https://uniswap.org', headers: {} }]);
      const quoters = [new WebhookQuoter(logger, webhookProvider)];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: {
            ...request,
          },
        });
      });

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      expect(response.statusCode).toEqual(404);
    });

    it('returns error if requestId is invalid', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([{ endpoint: 'https://uniswap.org', headers: {} }]);
      const quoters = [new WebhookQuoter(logger, webhookProvider)];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: {
            requestId: '1234',
            amountOut: amountIn.toString(),
          },
        });
      });

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      expect(response.statusCode).toEqual(404);
    });

    it('uses backup on failure', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([{ endpoint: 'https://uniswap.org', headers: {} }]);
      const quoters = [new WebhookQuoter(logger, webhookProvider), new MockQuoter(logger, 1, 1)];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: {
            ...request,
            quoteId: QUOTE_ID,
          },
        });
      });

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      expect(response.statusCode).toEqual(200);
      const quoteResponse: PostQuoteResponse = JSON.parse(response.body); // MockQuoter wins so returns a random quoteId
      expect(responseFromRequest(request, {})).toMatchObject({ ...quoteResponse, quoteId: expect.any(String) });
    });

    it('uses if better than backup', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([{ endpoint: 'https://uniswap.org', headers: {} }]);
      const quoters = [new WebhookQuoter(logger, webhookProvider), new MockQuoter(logger, 1, 1)];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: {
            amountOut: amountIn.mul(2).toString(),
            tokenIn: request.tokenIn,
            tokenOut: request.tokenOut,
            amountIn: request.amount,
            offerer: request.offerer,
            chainId: request.tokenInChainId,
            requestId: request.requestId,
            quoteId: QUOTE_ID,
          },
        });
      });

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      expect(response.statusCode).toEqual(200);
      const quoteResponse: PostQuoteResponse = JSON.parse(response.body);
      expect(responseFromRequest(request, { amountOut: amountIn.mul(2).toString() })).toMatchObject({
        ...quoteResponse,
        quoteId: QUOTE_ID,
      });
    });

    it('uses backup if better', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([{ endpoint: 'https://uniswap.org', headers: {} }]);
      const quoters = [new WebhookQuoter(logger, webhookProvider), new MockQuoter(logger, 1, 1)];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: {
            amountOut: amountIn.div(2).toString(),
            tokenIn: request.tokenIn,
            tokenOut: request.tokenOut,
            amountIn: request.amount,
            offerer: request.offerer,
            chainId: request.tokenInChainId,
            requestId: request.requestId,
            quoteId: QUOTE_ID,
          },
        });
      });

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      expect(response.statusCode).toEqual(200);
      const quoteResponse: PostQuoteResponse = JSON.parse(response.body); // MockQuoter wins so returns a random quoteId
      expect(responseFromRequest(request, { amountOut: amountIn.toString() })).toMatchObject({
        ...quoteResponse,
        quoteId: expect.any(String),
      });
    });
  });
});
