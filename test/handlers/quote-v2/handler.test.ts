import { createMetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import axios from 'axios';
import { default as Logger } from 'bunyan';
import { constants, ethers } from 'ethers';

import { AWSMetricsLogger } from '../../../lib/entities/aws-metrics-logger';
import { ApiInjector } from '../../../lib/handlers/base/api-handler';
import {
  IndicativeCInj,
  IndicativeQuoteHandler,
  IndicativeQuoteRequestBody,
  IndicativeQuoteResponseBody,
  IndicativeRInj,
  V2RfqResponse,
} from '../../../lib/handlers/quote-v2';
import { MockWebhookConfigurationProvider } from '../../../lib/providers';
import { FirehoseLogger } from '../../../lib/providers/analytics';
import { MockCircuitBreakerConfigurationProvider } from '../../../lib/providers/circuit-breaker/mock';
import { MockFillerComplianceConfigurationProvider } from '../../../lib/providers/compliance';
import { MOCK_FILLER_ADDRESS, V2MockQuoter, V2Quoter, V2WebhookQuoter } from '../../../lib/quoters';
import { FillerTimestampMap } from '../../../lib/repositories';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const SWAPPER = constants.AddressZero;
const COSIGNER = constants.AddressZero;
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CHAIN_ID = 1;
const NOW = Math.floor(Date.now() / 1000);
const FILLER_TIMESTAMPS: FillerTimestampMap = new Map([
  ['0xuni', { lastPostTimestamp: NOW - 100, blockUntilTimestamp: NaN }],
  ['google', { lastPostTimestamp: NOW - 100, blockUntilTimestamp: NOW + 100 }],
  ['0xsearcher', { lastPostTimestamp: NOW - 100, blockUntilTimestamp: NOW - 20 }],
]);

// silent logger in tests
const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

const emptyMockComplianceProvider = new MockFillerComplianceConfigurationProvider([]);
const mockComplianceProvider = new MockFillerComplianceConfigurationProvider([
  {
    endpoints: ['https://uniswap.org', 'google.com'],
    addresses: [SWAPPER],
  },
]);
const mockFirehoseLogger = new FirehoseLogger(logger, 'arn:aws:deliverystream/dummy');

describe('Quote handler', () => {
  // Creating mocks for all the handler dependencies.
  const requestInjectedMock: Promise<IndicativeRInj> = new Promise(
    (resolve) =>
      resolve({
        log: logger,
        requestId: 'test',
        metric: new AWSMetricsLogger(createMetricsLogger()),
      }) as unknown as IndicativeRInj
  );

  const injectorPromiseMock = (
    quoters: V2Quoter[]
  ): Promise<ApiInjector<IndicativeCInj, IndicativeRInj, IndicativeQuoteRequestBody, void>> =>
    new Promise((resolve) =>
      resolve({
        getContainerInjected: () => {
          return {
            quoters,
          };
        },
        getRequestInjected: () => requestInjectedMock,
      } as unknown as ApiInjector<IndicativeCInj, IndicativeRInj, IndicativeQuoteRequestBody, void>)
    );

  const getQuoteHandler = (quoters: V2Quoter[]) => new IndicativeQuoteHandler('quote', injectorPromiseMock(quoters));

  const getEvent = (request: IndicativeQuoteRequestBody): APIGatewayProxyEvent =>
    ({
      body: JSON.stringify(request),
    } as APIGatewayProxyEvent);

  const getRequest = (amount: string, type = 'EXACT_INPUT'): IndicativeQuoteRequestBody => ({
    requestId: REQUEST_ID,
    tokenInChainId: CHAIN_ID,
    tokenOutChainId: CHAIN_ID,
    swapper: SWAPPER,
    tokenIn: TOKEN_IN,
    amount,
    tokenOut: TOKEN_OUT,
    type,
    cosigner: COSIGNER,
    numOutputs: 1,
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const responseFromRequest = (
    request: IndicativeQuoteRequestBody,
    overrides: Partial<IndicativeQuoteResponseBody>
  ): IndicativeQuoteResponseBody => {
    return Object.assign(
      {},
      {
        amountOut: request.amount,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.amount,
        swapper: request.swapper,
        requestId: request.requestId,
        tokenInChainId: request.tokenInChainId,
        tokenOutChainId: request.tokenOutChainId,
        cosigner: request.cosigner,
        filler: MOCK_FILLER_ADDRESS,
        quoteId: QUOTE_ID,
      },
      overrides
    );
  };

  const rfqResponseFromRequest = (
    request: IndicativeQuoteRequestBody,
    overrides: Partial<IndicativeQuoteResponseBody>
  ): V2RfqResponse => {
    return Object.assign(
      {},
      {
        amountOut: request.amount,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.amount,
        swapper: request.swapper,
        requestId: request.requestId,
        chainId: request.tokenInChainId,
        cosigner: request.cosigner,
        filler: MOCK_FILLER_ADDRESS,
        quoteId: QUOTE_ID,
      },
      overrides
    );
  };

  it('Simple request and response', async () => {
    const quoters = [new V2MockQuoter(logger, 1, 1)];
    const amountIn = ethers.utils.parseEther('1');
    const request = getRequest(amountIn.toString());

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: IndicativeQuoteResponseBody = JSON.parse(response.body); // random quoteId
    expect(response.statusCode).toEqual(200);
    expect(responseFromRequest(request, {})).toMatchObject({ ...quoteResponse, quoteId: expect.any(String) });
  });

  it('Handles hex amount', async () => {
    const quoters = [new V2MockQuoter(logger, 1, 1)];
    const amountIn = ethers.utils.parseEther('1');
    const request = getRequest(amountIn.toHexString());

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: IndicativeQuoteResponseBody = JSON.parse(response.body); // random quoteId
    expect(response.statusCode).toEqual(200);
    expect(
      responseFromRequest(request, { amountIn: amountIn.toString(), amountOut: amountIn.toString() })
    ).toMatchObject({ ...quoteResponse, quoteId: expect.any(String) });
  });

  it('Pick the greater of two quotes - EXACT_IN', async () => {
    const quoters = [new V2MockQuoter(logger, 1, 1), new V2MockQuoter(logger, 2, 1)];
    const amountIn = ethers.utils.parseEther('1');
    const request = getRequest(amountIn.toString());

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: IndicativeQuoteResponseBody = JSON.parse(response.body); // random quoteId
    expect(response.statusCode).toEqual(200);
    expect(
      responseFromRequest(request, { amountOut: amountIn.mul(2).toString(), amountIn: amountIn.mul(1).toString() })
    ).toMatchObject({
      ...quoteResponse,
      quoteId: expect.any(String),
    });
  });

  it('Pick the lesser of two quotes - EXACT_OUT', async () => {
    const quoters = [new V2MockQuoter(logger, 1, 1), new V2MockQuoter(logger, 2, 1)];
    const amountOut = ethers.utils.parseEther('1');
    const request = getRequest(amountOut.toString(), 'EXACT_OUTPUT');

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: IndicativeQuoteResponseBody = JSON.parse(response.body); // random quoteId
    expect(response.statusCode).toEqual(200);
    expect(
      responseFromRequest(request, { amountOut: amountOut.mul(1).toString(), amountIn: amountOut.mul(1).toString() })
    ).toMatchObject({
      ...quoteResponse,
      quoteId: expect.any(String),
    });
  });

  it('Two quoters returning the same result', async () => {
    const quoters = [new V2MockQuoter(logger, 1, 1), new V2MockQuoter(logger, 1, 1)];
    const amountIn = ethers.utils.parseEther('1');
    const request = getRequest(amountIn.toString());

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: IndicativeQuoteResponseBody = JSON.parse(response.body); // random quoteId
    expect(response.statusCode).toEqual(200);
    expect(responseFromRequest(request, {})).toMatchObject({ ...quoteResponse, quoteId: expect.any(String) });
  });

  it('Invalid amountIn', async () => {
    const invalidAmounts = ['-100', 'aszzz', 'zz'];

    const quoters = [new V2MockQuoter(logger, 1, 1)];

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
      const webhookProvider = new MockWebhookConfigurationProvider([
        { endpoint: 'https://uniswap.org', headers: {}, name: 'uniswap', hash: '0xuni' },
      ]);

      const circuitBreakerProvider = new MockCircuitBreakerConfigurationProvider(
        ['0xuni', 'google'],
        FILLER_TIMESTAMPS
      );
      const quoters = [
        new V2WebhookQuoter(
          logger,
          mockFirehoseLogger,
          webhookProvider,
          circuitBreakerProvider,
          emptyMockComplianceProvider
        ),
      ];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      mockedAxios.post
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: {
              amountOut: amountIn.mul(2).toString(),
              requestId: request.requestId,
              tokenIn: request.tokenIn,
              tokenOut: request.tokenOut,
              amountIn: request.amount,
              swapper: request.swapper,
              chainId: request.tokenInChainId,
              filler: MOCK_FILLER_ADDRESS,
              quoteId: QUOTE_ID,
            },
          });
        })
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: {
              amountOut: amountIn.mul(3).toString(),
              requestId: request.requestId,
              tokenIn: request.tokenOut,
              tokenOut: request.tokenIn,
              amountIn: request.amount,
              swapper: request.swapper,
              chainId: request.tokenInChainId,
              filler: MOCK_FILLER_ADDRESS,
              quoteId: QUOTE_ID,
            },
          });
        });

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      const quoteResponse: IndicativeQuoteResponseBody = JSON.parse(response.body);
      expect(response.statusCode).toEqual(200);
      expect(quoteResponse).toMatchObject({
        amountOut: amountIn.mul(2).toString(),
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.amount,
        swapper: request.swapper,
        tokenInChainId: request.tokenInChainId,
        tokenOutChainId: request.tokenOutChainId,
        requestId: request.requestId,
        filler: MOCK_FILLER_ADDRESS,
        quoteId: expect.any(String),
      });
    });

    it('Passes headers', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([
        {
          name: 'uniswap',
          endpoint: 'https://uniswap.org',
          headers: {
            'X-Authentication': '1234',
          },
          hash: '0xuni',
        },
      ]);
      const circuitBreakerProvider = new MockCircuitBreakerConfigurationProvider(
        ['0xuni', 'google'],
        FILLER_TIMESTAMPS
      );
      const quoters = [
        new V2WebhookQuoter(
          logger,
          mockFirehoseLogger,
          webhookProvider,
          circuitBreakerProvider,
          emptyMockComplianceProvider
        ),
      ];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      mockedAxios.post
        .mockImplementationOnce((_endpoint, _req, options: any) => {
          expect(options.headers['X-Authentication']).toEqual('1234');
          return Promise.resolve({
            data: {
              ...rfqResponseFromRequest(request, { amountOut: amountIn.mul(2).toString() }),
            },
          });
        })
        .mockImplementationOnce((_endpoint, _req, options: any) => {
          expect(options.headers['X-Authentication']).toEqual('1234');
          const res = rfqResponseFromRequest(request, { amountOut: amountIn.mul(3).toString() });
          return Promise.resolve({
            data: {
              ...res,
              tokenIn: res.tokenOut,
              tokenOut: res.tokenIn,
            },
          });
        });

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      const quoteResponse: IndicativeQuoteResponseBody = JSON.parse(response.body);
      expect(response.statusCode).toEqual(200);
      expect(quoteResponse).toMatchObject({
        amountOut: amountIn.mul(2).toString(),
        amountIn: request.amount,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        tokenInChainId: request.tokenInChainId,
        tokenOutChainId: request.tokenOutChainId,
        swapper: request.swapper,
      });
    });

    it('handles invalid responses', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([
        { name: 'uniswap', endpoint: 'https://uniswap.org', headers: {}, hash: '0xuni' },
      ]);
      const circuitBreakerProvider = new MockCircuitBreakerConfigurationProvider(
        ['0xuni', 'google'],
        FILLER_TIMESTAMPS
      );
      const quoters = [
        new V2WebhookQuoter(
          logger,
          mockFirehoseLogger,
          webhookProvider,
          circuitBreakerProvider,
          emptyMockComplianceProvider
        ),
      ];
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
      const webhookProvider = new MockWebhookConfigurationProvider([
        { name: 'uniswap', endpoint: 'https://uniswap.org', headers: {}, hash: '0xuni' },
      ]);
      const circuitBreakerProvider = new MockCircuitBreakerConfigurationProvider(
        ['0xuni', 'google'],
        FILLER_TIMESTAMPS
      );
      const quoters = [
        new V2WebhookQuoter(
          logger,
          mockFirehoseLogger,
          webhookProvider,
          circuitBreakerProvider,
          emptyMockComplianceProvider
        ),
      ];
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
      const webhookProvider = new MockWebhookConfigurationProvider([
        { name: 'uniswap', endpoint: 'https://uniswap.org', headers: {}, hash: '0xuni' },
      ]);
      const circuitBreakerProvider = new MockCircuitBreakerConfigurationProvider(
        ['0xuni', 'google'],
        FILLER_TIMESTAMPS
      );
      const quoters = [
        new V2WebhookQuoter(
          logger,
          mockFirehoseLogger,
          webhookProvider,
          circuitBreakerProvider,
          emptyMockComplianceProvider
        ),
        new V2MockQuoter(logger, 1, 1),
      ];
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
      const quoteResponse: IndicativeQuoteResponseBody = JSON.parse(response.body); // V2MockQuoter wins so returns a random quoteId
      expect(responseFromRequest(request, {})).toMatchObject({ ...quoteResponse, quoteId: expect.any(String) });
    });

    it('uses if better than backup', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([
        { name: 'uniswap', endpoint: 'https://uniswap.org', headers: {}, hash: '0xuni' },
      ]);
      const circuitBreakerProvider = new MockCircuitBreakerConfigurationProvider(
        ['0xuni', 'google'],
        FILLER_TIMESTAMPS
      );
      const quoters = [
        new V2WebhookQuoter(
          logger,
          mockFirehoseLogger,
          webhookProvider,
          circuitBreakerProvider,
          emptyMockComplianceProvider
        ),
        new V2MockQuoter(logger, 1, 1),
      ];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      mockedAxios.post
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: {
              amountOut: amountIn.mul(2).toString(),
              tokenIn: request.tokenIn,
              tokenOut: request.tokenOut,
              amountIn: request.amount,
              swapper: request.swapper,
              chainId: request.tokenInChainId,
              requestId: request.requestId,
              filler: MOCK_FILLER_ADDRESS,
              quoteId: QUOTE_ID,
            },
          });
        })
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: {
              amountOut: amountIn.div(2).toString(),
              tokenIn: request.tokenOut,
              tokenOut: request.tokenIn,
              amountIn: request.amount,
              swapper: request.swapper,
              chainId: request.tokenInChainId,
              requestId: request.requestId,
              filler: MOCK_FILLER_ADDRESS,
              quoteId: QUOTE_ID,
            },
          });
        });

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      expect(response.statusCode).toEqual(200);
      const quoteResponse: IndicativeQuoteResponseBody = JSON.parse(response.body);
      expect(responseFromRequest(request, { amountOut: amountIn.mul(2).toString() })).toMatchObject({
        ...quoteResponse,
        quoteId: QUOTE_ID,
      });
    });

    it('uses backup if better', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([
        { name: 'uniswap', endpoint: 'https://uniswap.org', headers: {}, hash: '0xuni' },
      ]);
      const circuitBreakerProvider = new MockCircuitBreakerConfigurationProvider(
        ['0xuni', 'google'],
        FILLER_TIMESTAMPS
      );
      const quoters = [
        new V2WebhookQuoter(
          logger,
          mockFirehoseLogger,
          webhookProvider,
          circuitBreakerProvider,
          emptyMockComplianceProvider
        ),
        new V2MockQuoter(logger, 1, 1),
      ];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      mockedAxios.post.mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: {
            amountOut: amountIn.div(2).toString(),
            tokenIn: request.tokenIn,
            tokenOut: request.tokenOut,
            amountIn: request.amount,
            swapper: request.swapper,
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
      const quoteResponse: IndicativeQuoteResponseBody = JSON.parse(response.body); // V2MockQuoter wins so returns a random quoteId
      expect(responseFromRequest(request, { amountOut: amountIn.toString() })).toMatchObject({
        ...quoteResponse,
        quoteId: expect.any(String),
      });
    });

    it('respects filler compliance requirements', async () => {
      const webhookProvider = new MockWebhookConfigurationProvider([
        { name: 'uniswap', endpoint: 'https://uniswap.org', headers: {}, hash: '0xuni' },
      ]);
      const circuitBreakerProvider = new MockCircuitBreakerConfigurationProvider(
        ['0xuni', 'google'],
        FILLER_TIMESTAMPS
      );
      const quoters = [
        new V2WebhookQuoter(
          logger,
          mockFirehoseLogger,
          webhookProvider,
          circuitBreakerProvider,
          mockComplianceProvider
        ),
      ];
      const amountIn = ethers.utils.parseEther('1');
      const request = getRequest(amountIn.toString());

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      expect(response.statusCode).toEqual(404);
      const quoteResponse: IndicativeQuoteResponseBody = JSON.parse(response.body);
      expect(quoteResponse).toMatchObject(
        expect.objectContaining({
          errorCode: 'QUOTE_ERROR',
          detail: 'No quotes available',
        })
      );
    });
  });
});
