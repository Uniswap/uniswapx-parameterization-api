import { TradeType } from '@uniswap/sdk-core';
import axios from 'axios';
import { BigNumber, ethers } from 'ethers';

import { QuoteRequest } from '../../../lib/entities';
import { MockWebhookConfigurationProvider } from '../../../lib/providers';
import { MockCircuitBreakerConfigurationProvider } from '../../../lib/providers/circuit-breaker/mock';
import { WebhookQuoter } from '../../../lib/quoters';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const SWAPPER = '0x0000000000000000000000000000000000000000';
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CHAIN_ID = 1;
const FILLER = '0x0000000000000000000000000000000000000001';

const WEBHOOK_URL = 'https://uniswap.org';
const WEBHOOK_URL_ONEINCH = 'https://1inch.io';
const WEBHOOK_URL_SEARCHER = 'https://searcher.com';

describe('WebhookQuoter tests', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const webhookProvider = new MockWebhookConfigurationProvider([
    { name: 'uniswap', endpoint: WEBHOOK_URL, headers: {} },
    { name: '1inch', endpoint: WEBHOOK_URL_ONEINCH, headers: {} },
    { name: 'searcher', endpoint: WEBHOOK_URL_SEARCHER, headers: {} },
  ]);
  const circuitBreakerProvider = new MockCircuitBreakerConfigurationProvider([
    { name: 'uniswap', fadeRate: 0.05, enabled: true },
    { name: '1inch', fadeRate: 0.5, enabled: false },
    { name: 'searcher', fadeRate: 0.1, enabled: true },
  ]);
  const logger = { child: () => logger, info: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
  const webhookQuoter = new WebhookQuoter(logger, webhookProvider, circuitBreakerProvider);

  const request = new QuoteRequest({
    tokenInChainId: CHAIN_ID,
    tokenOutChainId: CHAIN_ID,
    requestId: REQUEST_ID,
    swapper: SWAPPER,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amount: ethers.utils.parseEther('1'),
    type: TradeType.EXACT_INPUT,
    numOutputs: 1,
  });

  const quote = {
    amountOut: ethers.utils.parseEther('2').toString(),
    tokenIn: request.tokenIn,
    tokenOut: request.tokenOut,
    amountIn: request.amount.toString(),
    swapper: request.swapper,
    chainId: request.tokenInChainId,
    requestId: request.requestId,
    quoteId: QUOTE_ID,
    filler: FILLER,
  };

  it('Simple request and response', async () => {
    mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
      return Promise.resolve({
        data: quote,
      });
    });
    const response = await webhookQuoter.quote(request);

    expect(response.length).toEqual(1);
    expect(response[0].toResponseJSON()).toEqual({ ...quote, quoteId: expect.any(String) });
  });

  // should only call 'uniswap' and 'searcher' given they are enabled in the config
  it('Only calls to eligible endpoints', async () => {
    mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
      return Promise.resolve({
        data: quote,
      });
    });
    await webhookQuoter.quote(request);

    expect(mockedAxios.post).toBeCalledWith(
      WEBHOOK_URL,
      { quoteId: expect.any(String), ...request.toCleanJSON() },
      { headers: {}, timeout: 500 }
    );
    expect(mockedAxios.post).toBeCalledWith(
      WEBHOOK_URL_SEARCHER,
      { quoteId: expect.any(String), ...request.toCleanJSON() },
      { headers: {}, timeout: 500 }
    );
    expect(mockedAxios.post).not.toBeCalledWith(WEBHOOK_URL_ONEINCH, request.toCleanJSON(), {
      headers: {},
      timeout: 500,
    });
  });

  it('Allows those in allow list even when they are disabled in the config', async () => {
    const webhookQuoter = new WebhookQuoter(
      logger,
      webhookProvider,
      circuitBreakerProvider,
      new Set<string>(['1inch'])
    );
    mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
      return Promise.resolve({
        data: quote,
      });
    });

    await webhookQuoter.quote(request);
    expect(mockedAxios.post).toBeCalledWith(
      WEBHOOK_URL,
      { quoteId: expect.any(String), ...request.toCleanJSON() },
      { headers: {}, timeout: 500 }
    );
    expect(mockedAxios.post).toBeCalledWith(
      WEBHOOK_URL_SEARCHER,
      { quoteId: expect.any(String), ...request.toCleanJSON() },
      { headers: {}, timeout: 500 }
    );
    expect(mockedAxios.post).toBeCalledWith(
      WEBHOOK_URL_ONEINCH,
      { quoteId: expect.any(String), ...request.toCleanJSON() },
      { headers: {}, timeout: 500 }
    );
  });

  it('Defaults to allowing endpoints not on circuit breaker config', async () => {
    mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
      return Promise.resolve({
        data: quote,
      });
    });
    const cbProvider = new MockCircuitBreakerConfigurationProvider([
      { name: 'uniswap', fadeRate: 0.05, enabled: true },
    ]);
    const quoter = new WebhookQuoter(logger, webhookProvider, cbProvider);
    await quoter.quote(request);
    expect(mockedAxios.post).toBeCalledWith(
      WEBHOOK_URL,
      { quoteId: expect.any(String), ...request.toCleanJSON() },
      { headers: {}, timeout: 500 }
    );
    expect(mockedAxios.post).toBeCalledWith(
      WEBHOOK_URL_SEARCHER,
      { quoteId: expect.any(String), ...request.toCleanJSON() },
      { headers: {}, timeout: 500 }
    );
    expect(mockedAxios.post).toBeCalledWith(
      WEBHOOK_URL_ONEINCH,
      { quoteId: expect.any(String), ...request.toCleanJSON() },
      {
        headers: {},
        timeout: 500,
      }
    );
  });

  it('Simple request and response no swapper', async () => {
    mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
      return Promise.resolve({
        data: quote,
      });
    });
    const response = await webhookQuoter.quote(request);

    expect(response.length).toEqual(1);
    expect(response[0].toResponseJSON()).toEqual({ ...quote, swapper: request.swapper, quoteId: expect.any(String) });
    expect(mockedAxios.post).toBeCalledWith(
      WEBHOOK_URL,
      { quoteId: expect.any(String), ...request.toOpposingCleanJSON() },
      { headers: {}, timeout: 500 }
    );
    expect(mockedAxios.post).toBeCalledWith(
      WEBHOOK_URL,
      { quoteId: expect.any(String), ...request.toCleanJSON() },
      { headers: {}, timeout: 500 }
    );
  });

  it('Simple request and response null swapper', async () => {
    const quote = {
      amountOut: ethers.utils.parseEther('2').toString(),
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: request.amount.toString(),
      chainId: request.tokenInChainId,
      requestId: request.requestId,
      quoteId: QUOTE_ID,
      swapper: null,
      filler: FILLER,
    };

    mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
      return Promise.resolve({
        data: quote,
      });
    });
    const response = await webhookQuoter.quote(request);

    expect(response.length).toEqual(1);
    expect(response[0].toResponseJSON()).toEqual({ ...quote, swapper: request.swapper, quoteId: expect.any(String) });
  });

  it('Simple request and response with explicit chainId', async () => {
    const provider = new MockWebhookConfigurationProvider([
      { name: 'uniswap', endpoint: WEBHOOK_URL, headers: {}, chainIds: [1] },
    ]);
    const quoter = new WebhookQuoter(logger, provider, circuitBreakerProvider);
    const quote = {
      amountOut: ethers.utils.parseEther('2').toString(),
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: request.amount.toString(),
      swapper: request.swapper,
      chainId: request.tokenInChainId,
      requestId: request.requestId,
      quoteId: QUOTE_ID,
      filler: FILLER,
    };

    mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
      return Promise.resolve({
        data: quote,
      });
    });
    const response = await quoter.quote(request);

    expect(response.length).toEqual(1);
    expect(response[0].toResponseJSON()).toEqual({ ...quote, quoteId: expect.any(String) });
  });

  it('Skips if chainId not configured', async () => {
    const provider = new MockWebhookConfigurationProvider([
      { name: 'uniswap', endpoint: WEBHOOK_URL, headers: {}, chainIds: [4, 5, 6] },
    ]);
    const quoter = new WebhookQuoter(logger, provider, circuitBreakerProvider);

    const response = await quoter.quote(request);

    expect(response.length).toEqual(0);

    expect(logger.debug).toHaveBeenCalledWith(
      {
        configuredChainIds: [4, 5, 6],
        chainId: request.tokenInChainId,
      },
      `chainId not configured for ${WEBHOOK_URL}`
    );
  });

  it('Invalid quote response from webhook, missing amountIn', async () => {
    const quote = {
      amountOut: ethers.utils.parseEther('2').toString(),
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      swapper: request.swapper,
      chainId: request.tokenInChainId,
      requestId: request.requestId,
      quoteId: QUOTE_ID,
      filler: FILLER,
    };

    mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
      return Promise.resolve({
        data: quote,
      });
    });
    const response = await webhookQuoter.quote(request);

    expect(logger.error).toHaveBeenCalledWith(
      {
        error: [
          {
            context: { key: 'amountIn', label: 'amountIn' },
            message: '"amountIn" is required',
            path: ['amountIn'],
            type: 'any.required',
          },
        ],
        response: {
          createdAt: expect.any(String),
          createdAtMs: expect.any(String),
          data: {
            ...quote,
            quoteId: expect.any(String),
            amountOut: BigNumber.from(quote.amountOut),
            amountIn: BigNumber.from(0),
          },
          type: 0,
        },
        webhookUrl: WEBHOOK_URL,
      },
      `Webhook Response failed validation. Webhook: ${WEBHOOK_URL}.`
    );
    expect(response).toEqual([]);
  });

  it('Invalid quote response from webhook, request/response mismatched requestId', async () => {
    const quote = {
      amountOut: ethers.utils.parseEther('2').toString(),
      amountIn: request.amount.toString(),
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      swapper: request.swapper,
      chainId: request.tokenInChainId,
      requestId: 'a83f397c-8ef4-4801-a9b7-6e7915504420',
      quoteId: QUOTE_ID,
      filler: FILLER,
    };

    mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
      return Promise.resolve({
        data: quote,
      });
    });
    const response = await webhookQuoter.quote(request);

    expect(logger.error).toHaveBeenCalledWith(
      {
        requestId: request.requestId,
        responseRequestId: quote.requestId,
      },
      'Webhook ResponseId does not match request'
    );
    expect(response).toEqual([]);
  });

  it('Counts as non-quote if response returns 404', async () => {
    mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
      return Promise.resolve({
        data: '',
        status: 404,
      });
    });
    const response = await webhookQuoter.quote(request);
    expect(logger.info).toHaveBeenCalledWith(
      {
        response: '',
        responseStatus: 404,
      },
      `Webhook elected not to quote: ${WEBHOOK_URL}`
    );

    expect(response.length).toEqual(0);
  });

  it('Counts as non-quote if response is zero exactInput', async () => {
    const quote = {
      amountOut: '0',
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: request.amount.toString(),
      swapper: request.swapper,
      chainId: request.tokenInChainId,
      requestId: request.requestId,
      quoteId: QUOTE_ID,
      filler: FILLER,
    };

    mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
      return Promise.resolve({
        data: quote,
        status: 200,
      });
    });
    const response = await webhookQuoter.quote(request);

    expect(response.length).toEqual(0);
    expect(logger.info).toHaveBeenCalledWith(
      {
        response: quote,
        responseStatus: 200,
      },
      `Webhook elected not to quote: ${WEBHOOK_URL}`
    );
  });

  it('Counts as non-quote if response is zero exactOutput', async () => {
    const quote = {
      amountOut: request.amount.toString(),
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: '0',
      swapper: request.swapper,
      chainId: request.tokenInChainId,
      requestId: request.requestId,
      quoteId: QUOTE_ID,
      filler: FILLER,
    };

    mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
      return Promise.resolve({
        data: quote,
        status: 200,
      });
    });
    const response = await webhookQuoter.quote(
      new QuoteRequest({
        tokenInChainId: CHAIN_ID,
        tokenOutChainId: CHAIN_ID,
        requestId: REQUEST_ID,
        swapper: SWAPPER,
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amount: ethers.utils.parseEther('1'),
        type: TradeType.EXACT_OUTPUT,
        numOutputs: 1,
      })
    );

    expect(response.length).toEqual(0);
    expect(logger.info).toHaveBeenCalledWith(
      {
        response: quote,
        responseStatus: 200,
      },
      `Webhook elected not to quote: ${WEBHOOK_URL}`
    );
  });
});
