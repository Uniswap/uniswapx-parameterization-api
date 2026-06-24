import { TradeType } from '@uniswap/sdk-core';
import axios from 'axios';
import { BigNumber, ethers } from 'ethers';

import { PERMISSIONED_TOKENS } from '@uniswap/uniswapx-sdk';
import { NOTIFICATION_TIMEOUT_MS } from '../../../lib/constants';
import { AnalyticsEventType, QuoteRequest, WebhookResponseType } from '../../../lib/entities';
import { MockWebhookConfigurationProvider, ProtocolVersion } from '../../../lib/providers';
import { FirehoseLogger } from '../../../lib/providers/analytics';
import { MockFillerComplianceConfigurationProvider } from '../../../lib/providers/compliance';
import { WebhookQuoter } from '../../../lib/quoters';
import { MockFillerAddressRepository } from '../../../lib/repositories/filler-address-repository';
import {
  MOCK_V2_CB_PROVIDER,
  WEBHOOK_URL,
  WEBHOOK_URL_FOO,
  WEBHOOK_URL_ONEINCH,
  WEBHOOK_URL_SEARCHER,
} from '../../fixtures';

jest.mock('axios');
jest.mock('../../../lib/providers/analytics');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const SWAPPER = '0x0000000000000000000000000000000000000000';
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CHAIN_ID = 1;
const FILLER = '0x0000000000000000000000000000000000000001';

const emptyMockComplianceProvider = new MockFillerComplianceConfigurationProvider([]);
const mockComplianceProvider = new MockFillerComplianceConfigurationProvider([
  {
    endpoints: ['https://uniswap.org', 'google.com'],
    addresses: [SWAPPER],
  },
]);
const repository = new MockFillerAddressRepository();

describe('WebhookQuoter tests', () => {
  beforeEach(() => {
    // Dispatch order is randomized in WebhookQuoter; pin it so the positional axios mocks
    // below (real response first, opposing second) line up deterministically.
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  const webhookProvider = new MockWebhookConfigurationProvider([
    {
      name: 'uniswap',
      endpoint: WEBHOOK_URL,
      headers: {},
      hash: '0xuni',
      supportedVersions: [ProtocolVersion.V1, ProtocolVersion.V2],
    },
    { name: '1inch', endpoint: WEBHOOK_URL_ONEINCH, headers: {}, hash: '0x1inch' },
    {
      name: 'searcher',
      endpoint: WEBHOOK_URL_SEARCHER,
      headers: {},
      hash: '0xsearcher',
      supportedVersions: [ProtocolVersion.V1, ProtocolVersion.V2],
    },
  ]);

  const logger = { child: jest.fn(() => logger), info: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
  const mockFirehoseLogger = new FirehoseLogger(logger, 'arn:aws:deliverystream/dummy');
  const webhookQuoter = new WebhookQuoter(
    logger,
    mockFirehoseLogger,
    webhookProvider,
    MOCK_V2_CB_PROVIDER,
    emptyMockComplianceProvider,
    repository
  );

  const makeQuoteRequest = (overrides: Partial<QuoteRequest>): QuoteRequest => {
    return new QuoteRequest({
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      requestId: REQUEST_ID,
      swapper: SWAPPER,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amount: ethers.utils.parseEther('1'),
      type: TradeType.EXACT_INPUT,
      numOutputs: 1,
      protocol: ProtocolVersion.V1,
      ...overrides,
    });
  };

  const request = makeQuoteRequest({});

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

  const sharedWebhookResponseEventProperties = {
    requestId: expect.any(String),
    quoteId: expect.any(String),
    name: 'uniswap',
    endpoint: WEBHOOK_URL,
    requestTime: expect.any(String),
    timeoutSettingMs: 500,
    responseTime: expect.any(String),
    latencyMs: expect.any(Number),
  };

  it('Simple request and response', async () => {
    mockedAxios.post
      .mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: { ...quote, requestId: (_req as any).requestId },
        });
      })
      .mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: {
            ...quote,
            tokenIn: request.tokenOut,
            tokenOut: request.tokenIn,
          },
        });
      });
    const response = await webhookQuoter.quote(request);

    expect(response.length).toEqual(1);
    expect(response[0].toResponseJSON()).toEqual({ ...quote, quoteId: expect.any(String) });
    expect(response[0].fillerName).toEqual('uniswap');
    expect(response[0].endpoint).toEqual(WEBHOOK_URL);
  });

  describe('opposing request obfuscation', () => {
    // Market makers echo back the requestId they received; mirror that so the real-leg
    // requestId check (which validates the echo against the obfuscated id we sent) passes.
    const echoReal = (req: any) => Promise.resolve({ data: { ...quote, requestId: req.requestId } });
    const echoOpposing = (req: any) =>
      Promise.resolve({
        data: { ...quote, tokenIn: request.tokenOut, tokenOut: request.tokenIn, requestId: req.requestId },
      });

    it('sends both the real and opposing requests with distinct, obfuscated requestIds', async () => {
      mockedAxios.post
        .mockImplementationOnce((_endpoint, _req, _options) => echoReal(_req))
        .mockImplementationOnce((_endpoint, _req, _options) => echoOpposing(_req));

      await webhookQuoter.quote(request);

      const uniswapBodies = mockedAxios.post.mock.calls
        .filter((call) => call[0] === WEBHOOK_URL)
        .map((call) => call[1] as any);
      const realBody = uniswapBodies.find((body) => body.tokenIn === request.tokenIn);
      const opposingBody = uniswapBodies.find((body) => body.tokenIn === request.tokenOut);

      // both wire requestIds are obfuscated: distinct from the original and from each other
      expect(realBody.requestId).toEqual(expect.any(String));
      expect(realBody.requestId).not.toEqual(request.requestId);
      expect(opposingBody.requestId).not.toEqual(request.requestId);
      expect(opposingBody.requestId).not.toEqual(realBody.requestId);
      // each side still gets its own randomized quoteId
      expect(opposingBody.quoteId).not.toEqual(realBody.quoteId);
    });

    it('restores the original requestId on the response returned to the caller', async () => {
      mockedAxios.post
        .mockImplementationOnce((_endpoint, _req, _options) => echoReal(_req))
        .mockImplementationOnce((_endpoint, _req, _options) => echoOpposing(_req));

      const response = await webhookQuoter.quote(request);

      expect(response.length).toEqual(1);
      // the filler echoed the obfuscated wire id, but the caller sees the original requestId
      expect(response[0].requestId).toEqual(request.requestId);
      expect(response[0].toResponseJSON().requestId).toEqual(request.requestId);
    });

    it('selects the real response even when the opposing request is dispatched first', async () => {
      // realRequestFirst = false: the opposing request is dispatched before the real one
      (Math.random as jest.Mock).mockReturnValue(0.9);

      mockedAxios.post
        .mockImplementationOnce((_endpoint, _req, _options) => echoOpposing(_req))
        .mockImplementationOnce((_endpoint, _req, _options) => echoReal(_req));

      const response = await webhookQuoter.quote(request);

      expect(response.length).toEqual(1);
      expect(response[0].toResponseJSON()).toEqual({ ...quote, quoteId: expect.any(String) });
      expect(response[0].endpoint).toEqual(WEBHOOK_URL);
    });

    it('logs both the original and obfuscated requestId for each leg', async () => {
      mockedAxios.post
        .mockImplementationOnce((_endpoint, _req, _options) => echoReal(_req))
        .mockImplementationOnce((_endpoint, _req, _options) => echoOpposing(_req));

      await webhookQuoter.quote(request);

      const requestLogs = (logger.info as jest.Mock).mock.calls.filter(
        (call) => typeof call[1] === 'string' && call[1].startsWith('Webhook request to:')
      );
      const realLog = requestLogs.find((call) => call[0].request.tokenIn === request.tokenIn);
      const opposingLog = requestLogs.find((call) => call[0].request.tokenIn === request.tokenOut);

      // each leg logs the original requestId (for correlation) and the obfuscated wire id
      // (so a requestId a partner reports can be traced back to the original)
      expect(realLog[0].request.requestId).toEqual(request.requestId);
      expect(realLog[0].obfuscatedRequestId).toEqual(expect.any(String));
      expect(realLog[0].obfuscatedRequestId).not.toEqual(request.requestId);
      expect(opposingLog[0].request.requestId).toEqual(request.requestId);
      expect(opposingLog[0].obfuscatedRequestId).not.toEqual(request.requestId);
      expect(opposingLog[0].obfuscatedRequestId).not.toEqual(realLog[0].obfuscatedRequestId);
    });
  });

  it('adds filler metadata to response', async () => {
    mockedAxios.post
      .mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: { ...quote, requestId: (_req as any).requestId },
        });
      })
      .mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: {
            ...quote,
            tokenIn: request.tokenOut,
            tokenOut: request.tokenIn,
          },
        });
      })
      .mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: { ...quote, requestId: (_req as any).requestId },
        });
      })
      .mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: {
            ...quote,
            tokenIn: request.tokenOut,
            tokenOut: request.tokenIn,
          },
        });
      });
    const response = await webhookQuoter.quote(request);
    expect(response.length).toEqual(2);
    expect(['uniswap', 'searcher']).toContain(response[0].fillerName);
    expect(['uniswap', 'searcher']).toContain(response[1].fillerName);
    expect([WEBHOOK_URL, WEBHOOK_URL_SEARCHER]).toContain(response[0].endpoint);
    expect([WEBHOOK_URL, WEBHOOK_URL_SEARCHER]).toContain(response[1].endpoint);
  });

  it('updates filler addresses', async () => {
    mockedAxios.post
      .mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: { ...quote, requestId: (_req as any).requestId },
        });
      })
      .mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: {
            ...quote,
            tokenIn: request.tokenOut,
            tokenOut: request.tokenIn,
          },
        });
      });
    await webhookQuoter.quote(request);
    expect(repository.getFillerAddresses(WEBHOOK_URL)).resolves.toEqual([FILLER]);
  });

  it('Respects filler compliance requirements', async () => {
    const webhookQuoter = new WebhookQuoter(
      logger,
      mockFirehoseLogger,
      webhookProvider,
      MOCK_V2_CB_PROVIDER,
      mockComplianceProvider,
      repository
    );

    await expect(webhookQuoter.quote(request)).resolves.toStrictEqual([]);
  });

  describe('Circuit Breaker v2 tests', () => {
    /*
     should only call 'uniswap' and 'searcher' because
      - '0xuni' not in fillerTimestampMap
      - '0x1inch' has blockUntilTimestamp in the future
      - '0xsearcher' has blockUntilTimestamp in the past
   */
    it('Only calls to eligible endpoints', async () => {
      mockedAxios.post
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: { ...quote, requestId: (_req as any).requestId },
          });
        })
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: {
              ...quote,
              tokenIn: request.tokenOut,
              tokenOut: request.tokenIn,
            },
          });
        });
      await webhookQuoter.quote(request);

      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL,
        { quoteId: expect.any(String), ...request.toCleanJSON(), requestId: expect.any(String) },
        { headers: {}, timeout: 500 }
      );
      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL_SEARCHER,
        { quoteId: expect.any(String), ...request.toCleanJSON(), requestId: expect.any(String) },
        { headers: {}, timeout: 500 }
      );
      expect(mockedAxios.post).not.toBeCalledWith(
        WEBHOOK_URL_ONEINCH,
        {
          quoteId: expect.any(String),
          ...request.toCleanJSON(),
        },
        {
          headers: {},
          timeout: 500,
        }
      );
    });

    it('notify fillers of circuit breaker status', async () => {
      mockedAxios.post
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: { ...quote, requestId: (_req as any).requestId },
          });
        })
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: {
              ...quote,
              tokenIn: request.tokenOut,
              tokenOut: request.tokenIn,
            },
          });
        });

      await webhookQuoter.quote(request);
      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL_ONEINCH,
        {
          blockUntilTimestamp: expect.any(Number),
        },
        {
          headers: {},
          timeout: NOTIFICATION_TIMEOUT_MS,
        }
      );
    });

    it('Calls to all endpoints if tokenIn is permissioned', async () => {
      mockedAxios.post
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: {
              ...quote,
              tokenIn: PERMISSIONED_TOKENS[0].address,
            },
          });
        })
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: {
              ...quote,
              tokenIn: request.tokenOut,
              tokenOut: PERMISSIONED_TOKENS[0].address,
            },
          });
        });

      const permissionedTokenRequest = makeQuoteRequest({
        tokenIn: PERMISSIONED_TOKENS[0].address,
        protocol: ProtocolVersion.V2,
      });
      await webhookQuoter.quote(permissionedTokenRequest);

      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL,
        { quoteId: expect.any(String), ...permissionedTokenRequest.toCleanJSON(), requestId: expect.any(String) },
        { headers: {}, timeout: 500 }
      );
      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL_SEARCHER,
        { quoteId: expect.any(String), ...permissionedTokenRequest.toCleanJSON(), requestId: expect.any(String) },
        { headers: {}, timeout: 500 }
      );
      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL_ONEINCH,
        { quoteId: expect.any(String), ...permissionedTokenRequest.toCleanJSON(), requestId: expect.any(String) },
        { headers: {}, timeout: 500 }
      );
    });

    it('Calls to all endpoints if tokenOut is permissioned', async () => {
      mockedAxios.post
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: {
              ...quote,
              tokenOut: PERMISSIONED_TOKENS[0].address,
            },
          });
        })
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: {
              ...quote,
              tokenIn: PERMISSIONED_TOKENS[0].address,
              tokenOut: request.tokenIn,
            },
          });
        });

      const permissionedTokenRequest = makeQuoteRequest({
        tokenOut: PERMISSIONED_TOKENS[0].address,
        protocol: ProtocolVersion.V2,
      });
      await webhookQuoter.quote(permissionedTokenRequest);

      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL,
        { quoteId: expect.any(String), ...permissionedTokenRequest.toCleanJSON(), requestId: expect.any(String) },
        { headers: {}, timeout: 500 }
      );
      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL_SEARCHER,
        { quoteId: expect.any(String), ...permissionedTokenRequest.toCleanJSON(), requestId: expect.any(String) },
        { headers: {}, timeout: 500 }
      );
      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL_ONEINCH,
        { quoteId: expect.any(String), ...permissionedTokenRequest.toCleanJSON(), requestId: expect.any(String) },
        { headers: {}, timeout: 500 }
      );
    });

    it('Permissioned tokens still filter on supported protocol', async () => {
      mockedAxios.post
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: {
              ...quote,
              tokenIn: PERMISSIONED_TOKENS[0].address,
            },
          });
        })
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: {
              ...quote,
              tokenIn: request.tokenOut,
              tokenOut: PERMISSIONED_TOKENS[0].address,
            },
          });
        });

      const permissionedTokenRequest = makeQuoteRequest({
        tokenIn: PERMISSIONED_TOKENS[0].address,
        protocol: ProtocolVersion.V1, // 1Inch only supports v2
      });
      await webhookQuoter.quote(permissionedTokenRequest);

      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL,
        { quoteId: expect.any(String), ...permissionedTokenRequest.toCleanJSON(), requestId: expect.any(String) },
        { headers: {}, timeout: 500 }
      );
      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL_SEARCHER,
        { quoteId: expect.any(String), ...permissionedTokenRequest.toCleanJSON(), requestId: expect.any(String) },
        { headers: {}, timeout: 500 }
      );
      expect(mockedAxios.post).not.toBeCalledWith(
        WEBHOOK_URL_ONEINCH,
        { quoteId: expect.any(String), ...permissionedTokenRequest.toCleanJSON(), requestId: expect.any(String) },
        { headers: {}, timeout: 500 }
      );
    });
  });

  describe('Supported protocols tests', () => {
    const webhookProvider = new MockWebhookConfigurationProvider([
      {
        name: 'uniswap',
        endpoint: WEBHOOK_URL,
        headers: {},
        hash: '0xuni',
        supportedVersions: [ProtocolVersion.V1, ProtocolVersion.V2, ProtocolVersion.V3],
      },
      { name: '1inch', endpoint: WEBHOOK_URL_ONEINCH, headers: {}, hash: '0x1inch' },
      {
        name: 'searcher',
        endpoint: WEBHOOK_URL_SEARCHER,
        headers: {},
        hash: '0xsearcher',
        supportedVersions: [ProtocolVersion.V1, ProtocolVersion.V2],
      },
      {
        name: 'foo',
        endpoint: WEBHOOK_URL_FOO,
        headers: {},
        hash: '0xfoo',
      },
    ]);
    const webhookQuoter = new WebhookQuoter(
      logger,
      mockFirehoseLogger,
      webhookProvider,
      MOCK_V2_CB_PROVIDER,
      emptyMockComplianceProvider,
      repository
    );
    it('v1 quote request only sent to fillers supporting v1', async () => {
      mockedAxios.post
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: { ...quote, requestId: (_req as any).requestId },
          });
        })
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: {
              ...quote,
              tokenIn: request.tokenOut,
              tokenOut: request.tokenIn,
            },
          });
        });

      await webhookQuoter.quote(request);
      // blocked
      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL_ONEINCH,
        { blockUntilTimestamp: expect.any(Number) },
        { headers: {}, timeout: NOTIFICATION_TIMEOUT_MS }
      );
      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL_SEARCHER,
        { quoteId: expect.any(String), ...request.toCleanJSON(), requestId: expect.any(String) },
        { headers: {}, timeout: 500 }
      );
      expect(mockedAxios.post).not.toBeCalledWith(WEBHOOK_URL, request.toCleanJSON(), {
        headers: {},
        timeout: 500,
      });
      // empty supportedVersions defaults to v2 and v3
      expect(mockedAxios.post).not.toBeCalledWith(WEBHOOK_URL_FOO, request.toCleanJSON(), {
        headers: {},
        timeout: 500,
      });
    });

    it('v2 quote request only sent to fillers supporting v2', async () => {
      mockedAxios.post
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: { ...quote, requestId: (_req as any).requestId },
          });
        })
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: {
              ...quote,
              tokenIn: request.tokenOut,
              tokenOut: request.tokenIn,
            },
          });
        });

      const request = makeQuoteRequest({ protocol: ProtocolVersion.V2 });
      await webhookQuoter.quote(request);
      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL,
        { quoteId: expect.any(String), ...request.toCleanJSON(), requestId: expect.any(String) },
        { headers: {}, timeout: 500 }
      );
      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL_SEARCHER,
        { quoteId: expect.any(String), ...request.toCleanJSON(), requestId: expect.any(String) },
        {
          headers: {},
          timeout: 500,
        }
      );
      // empty config defaults to v2 and v3
      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL_FOO,
        { quoteId: expect.any(String), ...request.toCleanJSON(), requestId: expect.any(String) },
        {
          headers: {},
          timeout: 500,
        }
      );
    });

    it('v3 quote request only sent to fillers supporting v3', async () => {
      mockedAxios.post
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: { ...quote, requestId: (_req as any).requestId },
          });
        })
        .mockImplementationOnce((_endpoint, _req, _options) => {
          return Promise.resolve({
            data: {
              ...quote,
              tokenIn: request.tokenOut,
              tokenOut: request.tokenIn,
            },
          });
        });

      const request = makeQuoteRequest({ protocol: ProtocolVersion.V3 });
      await webhookQuoter.quote(request);
      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL,
        { quoteId: expect.any(String), ...request.toCleanJSON(), requestId: expect.any(String) },
        { headers: {}, timeout: 500 }
      );
      expect(mockedAxios.post).not.toBeCalledWith(
        WEBHOOK_URL_SEARCHER,
        { quoteId: expect.any(String), ...request.toCleanJSON(), requestId: expect.any(String) },
        {
          headers: {},
          timeout: 500,
        }
      );
      // empty config defaults to v2 and v3
      expect(mockedAxios.post).toBeCalledWith(
        WEBHOOK_URL_FOO,
        { quoteId: expect.any(String), ...request.toCleanJSON(), requestId: expect.any(String) },
        {
          headers: {},
          timeout: 500,
        }
      );
    });
  });

  it('Simple request and response no swapper', async () => {
    mockedAxios.post
      .mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: { ...quote, requestId: (_req as any).requestId },
        });
      })
      .mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: {
            ...quote,
            tokenIn: request.tokenOut,
            tokenOut: request.tokenIn,
          },
        });
      });
    const response = await webhookQuoter.quote(request);

    expect(response.length).toEqual(1);
    expect(response[0].toResponseJSON()).toEqual({ ...quote, swapper: request.swapper, quoteId: expect.any(String) });
    expect(mockedAxios.post).toBeCalledWith(
      WEBHOOK_URL,
      // opposing request carries a distinct, randomized requestId (obfuscation)
      { quoteId: expect.any(String), ...request.toOpposingCleanJSON(), requestId: expect.any(String) },
      { headers: {}, timeout: 500 }
    );
    expect(mockedAxios.post).toBeCalledWith(
      WEBHOOK_URL,
      { quoteId: expect.any(String), ...request.toCleanJSON(), requestId: expect.any(String) },
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

    mockedAxios.post
      .mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: { ...quote, requestId: (_req as any).requestId },
        });
      })
      .mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: {
            ...quote,
            tokenIn: request.tokenOut,
            tokenOut: request.tokenIn,
          },
        });
      });
    const response = await webhookQuoter.quote(request);

    expect(response.length).toEqual(1);
    expect(response[0].toResponseJSON()).toEqual({ ...quote, swapper: request.swapper, quoteId: expect.any(String) });
  });

  it('Simple request and response with explicit chainId', async () => {
    const provider = new MockWebhookConfigurationProvider([
      { name: 'uniswap', endpoint: WEBHOOK_URL, headers: {}, chainIds: [1], hash: '0xuni' },
    ]);
    const quoter = new WebhookQuoter(
      logger,
      mockFirehoseLogger,
      provider,
      MOCK_V2_CB_PROVIDER,
      emptyMockComplianceProvider,
      repository
    );
    const request = makeQuoteRequest({ tokenInChainId: 1, tokenOutChainId: 1, protocol: ProtocolVersion.V2 });
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

    mockedAxios.post
      .mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: { ...quote, requestId: (_req as any).requestId },
        });
      })
      .mockImplementationOnce((_endpoint, _req, _options) => {
        return Promise.resolve({
          data: {
            ...quote,
            tokenIn: request.tokenOut,
            tokenOut: request.tokenIn,
          },
        });
      });
    const response = await quoter.quote(request);

    expect(response.length).toEqual(1);
    expect(response[0].toResponseJSON()).toEqual({ ...quote, quoteId: expect.any(String) });
  });

  it('Skips if chainId not configured', async () => {
    const request = makeQuoteRequest({ protocol: ProtocolVersion.V2 });
    const provider = new MockWebhookConfigurationProvider([
      { name: 'uniswap', endpoint: WEBHOOK_URL, headers: {}, chainIds: [4, 5, 6], hash: '0xuni' },
    ]);
    const quoter = new WebhookQuoter(
      logger,
      mockFirehoseLogger,
      provider,
      MOCK_V2_CB_PROVIDER,
      emptyMockComplianceProvider,
      repository
    );

    const response = await quoter.quote(request);

    expect(response.length).toEqual(0);

    // requestId is bound on the child logger (asserted via logger.child elsewhere), not on the log object.
    expect(logger.child).toHaveBeenCalledWith({ requestId: request.requestId });
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
        status: 200,
      });
    });
    const response = await webhookQuoter.quote(request);

    expect(logger.error).toHaveBeenCalledWith(
      {
        error: {
          message: '"amountIn" is required',
          value: expect.any(Object),
        },
        response: {
          createdAt: expect.any(String),
          createdAtMs: expect.any(String),
          fillerResponseLatencyMs: expect.any(Number),
          data: {
            ...quote,
            quoteId: expect.any(String),
            amountOut: BigNumber.from(quote.amountOut),
            amountIn: BigNumber.from(request.amount),
          },
          metadata: {
            endpoint: WEBHOOK_URL,
            fillerName: 'uniswap',
          },
          type: 0,
        },
        webhookUrl: WEBHOOK_URL,
      },
      `Webhook Response failed validation. Webhook: ${WEBHOOK_URL}.`
    );
    expect(mockFirehoseLogger.sendAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AnalyticsEventType.WEBHOOK_RESPONSE,
        eventProperties: {
          ...sharedWebhookResponseEventProperties,
          status: 200,
          data: quote,
          algo_id: FILLER,
          responseType: WebhookResponseType.VALIDATION_ERROR,
          validationError: {
            message: '"amountIn" is required',
            value: expect.any(Object),
          },
        },
      })
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
        status: 200,
      });
    });
    const response = await webhookQuoter.quote(request);

    expect(logger.error).toHaveBeenCalledWith(
      {
        requestId: request.requestId,
        obfuscatedRequestId: expect.any(String),
        responseRequestId: quote.requestId,
      },
      'Webhook ResponseId does not match request'
    );
    expect(mockFirehoseLogger.sendAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AnalyticsEventType.WEBHOOK_RESPONSE,
        eventProperties: {
          ...sharedWebhookResponseEventProperties,
          status: 200,
          data: quote,
          algo_id: FILLER,
          responseType: WebhookResponseType.REQUEST_ID_MISMATCH,
          mismatchedRequestId: quote.requestId,
        },
      })
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
    // logs in fetchQuote go through a child logger bound with the request id, then enriched with the quote id
    expect(logger.child).toHaveBeenCalledWith({ requestId: request.requestId });
    expect(logger.child).toHaveBeenCalledWith({ quoteId: expect.any(String) });
    expect(logger.info).toHaveBeenCalledWith(
      {
        response: '',
        responseStatus: 404,
      },
      `Webhook elected not to quote: ${WEBHOOK_URL}`
    );
    expect(mockFirehoseLogger.sendAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AnalyticsEventType.WEBHOOK_RESPONSE,
        eventProperties: {
          ...sharedWebhookResponseEventProperties,
          status: 404,
          data: '',
          algo_id: undefined,
          responseType: WebhookResponseType.NON_QUOTE,
        },
      })
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
    expect(mockFirehoseLogger.sendAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AnalyticsEventType.WEBHOOK_RESPONSE,
        eventProperties: {
          ...sharedWebhookResponseEventProperties,
          status: 200,
          data: quote,
          algo_id: FILLER,
          responseType: WebhookResponseType.NON_QUOTE,
        },
      })
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
        protocol: ProtocolVersion.V1,
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
    expect(mockFirehoseLogger.sendAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AnalyticsEventType.WEBHOOK_RESPONSE,
        eventProperties: {
          ...sharedWebhookResponseEventProperties,
          status: 200,
          data: quote,
          algo_id: FILLER,
          responseType: WebhookResponseType.NON_QUOTE,
        },
      })
    );
  });
});
