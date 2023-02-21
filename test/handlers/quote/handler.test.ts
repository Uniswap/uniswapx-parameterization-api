import DEFAULT_TOKEN_LIST from '@uniswap/default-token-list';
import { CurrencyAmount, Token } from '@uniswap/sdk-core';
import { AlphaRouter, CachingTokenListProvider, ITokenProvider, NodeJSCache } from '@uniswap/smart-order-router';
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import axios from 'axios';
import { default as Logger } from 'bunyan';
import { BigNumber, ethers } from 'ethers';
import NodeCache from 'node-cache';

import { QuoteRequestDataJSON } from '../../../lib/entities/QuoteRequest';
import { ApiInjector, ApiRInj } from '../../../lib/handlers/base/api-handler';
import { ContainerInjected, PostQuoteRequestBody, PostQuoteResponse } from '../../../lib/handlers/quote';
import { QuoteHandler } from '../../../lib/handlers/quote/handler';
import { MockWebhookConfigurationProvider } from '../../../lib/providers';
import { AutoRouterQuoter, MockQuoter, Quoter, WebhookQuoter } from '../../../lib/quoters';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

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
    chainId: CHAIN_ID,
    offerer: OFFERER,
    tokenIn: TOKEN_IN,
    amountIn: amountIn,
    tokenOut: TOKEN_OUT,
  });

  const mockTokenProvider = (chainId: number): ITokenProvider => {
    const tokenCache = new NodeJSCache<Token>(new NodeCache({ stdTTL: 3600, useClones: false }));
    return new CachingTokenListProvider(chainId, DEFAULT_TOKEN_LIST, tokenCache);
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('Simple request and response', async () => {
    const quoters = [new MockQuoter(logger, 1, 1)];
    const amountIn = ethers.utils.parseEther('1');
    const request = getRequest(amountIn.toString());

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: PostQuoteResponse = JSON.parse(response.body);
    expect(response.statusCode).toEqual(200);
    expect(quoteResponse).toMatchObject({
      amountOut: amountIn.toString(),
      ...request,
    });
  });

  it('Handles hex amount', async () => {
    const quoters = [new MockQuoter(logger, 1, 1)];
    const amountIn = ethers.utils.parseEther('1');
    const request = getRequest(amountIn.toHexString());

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: PostQuoteResponse = JSON.parse(response.body);
    expect(response.statusCode).toEqual(200);
    expect(quoteResponse).toMatchObject({
      ...request,
      amountOut: amountIn.toString(),
      amountIn: amountIn.toString(),
    });
  });

  it('Pick the greater of two quotes', async () => {
    const quoters = [new MockQuoter(logger, 1, 1), new MockQuoter(logger, 2, 1)];
    const amountIn = ethers.utils.parseEther('1');
    const request = getRequest(amountIn.toString());

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: PostQuoteResponse = JSON.parse(response.body);
    expect(response.statusCode).toEqual(200);
    expect(quoteResponse).toMatchObject({
      amountOut: amountIn.mul(2).toString(),
      ...request,
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
    const quoteResponse: PostQuoteResponse = JSON.parse(response.body);
    expect(response.statusCode).toEqual(200);
    expect(quoteResponse).toMatchObject({
      amountOut: amountIn.toString(),
      ...request,
    });
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

      mockedAxios.post.mockImplementationOnce((_endpoint, req, _options) => {
        const requestId = (req as QuoteRequestDataJSON).requestId;
        return Promise.resolve({
          data: {
            requestId,
            amountOut: amountIn.mul(2).toString(),
            ...request,
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
        ...request,
      });
    });

    it('Passes headers', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([{ endpoint: 'https://uniswap.org', headers: {
        'X-Authentication': '1234',
      } }]);
      const quoters = [new WebhookQuoter(logger, webhookProvider)];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      mockedAxios.post.mockImplementationOnce((_endpoint, req, options: any) => {
        const requestId = (req as QuoteRequestDataJSON).requestId;
        expect(options.headers['X-Authentication']).toEqual('1234');
        return Promise.resolve({
          data: {
            requestId,
            amountOut: amountIn.mul(2).toString(),
            ...request,
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
        ...request,
      });
    });

    it('handles invalid responses', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([{ endpoint: 'https://uniswap.org', headers: {} }]);
      const quoters = [new WebhookQuoter(logger, webhookProvider)];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      mockedAxios.post.mockImplementationOnce((_endpoint, req, _options) => {
        const requestId = (req as QuoteRequestDataJSON).requestId;
        return Promise.resolve({
          data: {
            requestId,
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

    it('uses backup on failure', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([{ endpoint: 'https://uniswap.org', headers: {} }]);
      const quoters = [new WebhookQuoter(logger, webhookProvider), new MockQuoter(logger, 1, 1)];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: {
            requestId: '1234',
            ...request,
          },
        });
      });

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      expect(response.statusCode).toEqual(200);
      const quoteResponse: PostQuoteResponse = JSON.parse(response.body);
      expect(quoteResponse).toMatchObject({
        amountOut: amountIn.toString(),
        ...request,
      });
    });

    it('uses if better than backup', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([{ endpoint: 'https://uniswap.org', headers: {} }]);
      const quoters = [new WebhookQuoter(logger, webhookProvider), new MockQuoter(logger, 1, 1)];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      mockedAxios.post.mockImplementationOnce((_endpoint, req, _options) => {
        const requestId = (req as QuoteRequestDataJSON).requestId;
        return Promise.resolve({
          data: {
            requestId,
            amountOut: amountIn.mul(2).toString(),
            ...request,
          },
        });
      });

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      expect(response.statusCode).toEqual(200);
      const quoteResponse: PostQuoteResponse = JSON.parse(response.body);
      expect(quoteResponse).toMatchObject({
        amountOut: amountIn.mul(2).toString(),
        ...request,
      });
    });

    it('uses backup if better', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([{ endpoint: 'https://uniswap.org', headers: {} }]);
      const quoters = [new WebhookQuoter(logger, webhookProvider), new MockQuoter(logger, 1, 1)];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      mockedAxios.post.mockImplementationOnce((_endpoint, req, _options) => {
        const requestId = (req as QuoteRequestDataJSON).requestId;
        return Promise.resolve({
          data: {
            requestId,
            amountOut: amountIn.div(2).toString(),
            ...request,
          },
        });
      });

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      expect(response.statusCode).toEqual(200);
      const quoteResponse: PostQuoteResponse = JSON.parse(response.body);
      expect(quoteResponse).toMatchObject({
        amountOut: amountIn.toString(),
        ...request,
      });
    });
  });

  describe('AutoRouter Quoter', () => {
    const buildDependencies = (amountOut: BigNumber) => {
      return {
        [CHAIN_ID]: {
          chainId: CHAIN_ID,
          tokenProvider: mockTokenProvider(1),
          router: {
            route: () => {
              return Promise.resolve({
                quoteGasAdjusted: CurrencyAmount.fromRawAmount(
                  new Token(CHAIN_ID, TOKEN_OUT, 18),
                  amountOut.toString()
                ),
              });
            },
          } as unknown as AlphaRouter,
        },
      };
    };

    it('Simple request and response', async () => {
      const amountIn = ethers.utils.parseEther('1');
      const quoters = [new AutoRouterQuoter(logger, buildDependencies(amountIn.mul(2)))];
      const request = getRequest(amountIn.toString());

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      const quoteResponse: PostQuoteResponse = JSON.parse(response.body);
      expect(response.statusCode).toEqual(200);
      expect(quoteResponse).toMatchObject({
        amountOut: amountIn.mul(2).toString(),
        ...request,
      });
    });

    it('Fails if token is not in the tokenlist', async () => {
      const amountIn = ethers.utils.parseEther('1');
      const quoters = [new AutoRouterQuoter(logger, buildDependencies(amountIn.mul(2)))];
      const request = getRequest(amountIn.toString());
      request.tokenIn = ethers.constants.AddressZero;

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      const quoteResponse: PostQuoteResponse = JSON.parse(response.body);
      expect(response.statusCode).toEqual(404);
      expect(quoteResponse).toMatchObject({
        detail: 'No quotes available',
        errorCode: 'QUOTE_ERROR',
        id: 'test',
      });
    });
  });
});
