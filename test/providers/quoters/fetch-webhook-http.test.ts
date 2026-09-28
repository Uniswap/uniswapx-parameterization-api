import { TradeType } from '@uniswap/sdk-core';
import axios, { AxiosError } from 'axios';
import { ethers } from 'ethers';
import http, { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { AnalyticsEventType, QuoteRequest } from '../../../lib/entities';
import { selectWebhookHttp } from '../../../lib/handlers/shared/quote-injector';
import { MockWebhookConfigurationProvider, ProtocolVersion, WebhookConfiguration } from '../../../lib/providers';
import { MockV2CircuitBreakerConfigurationProvider } from '../../../lib/providers/circuit-breaker/mock';
import { fetchWebhookHttp, WEBHOOK_HTTP_CLIENT_ENV, WebhookHttp, WebhookQuoter } from '../../../lib/quoters';
import { FakeAnalyticsLogger, fakeContext } from '../../fakes';

// Every test here runs both clients against the same real HTTP server and asserts they agree.
// The quoter's classification (quote / non-quote / timeout / error) and the analytics records
// it writes are keyed off what axios resolves and rejects, so "the same" is the contract.

interface RecordedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const recorded: RecordedRequest[] = [];
let baseUrl = '';
let closedPortUrl = '';
let server: http.Server;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// A market maker that quotes 2x on whatever it's asked, echoing the ids it was sent.
function quoteFor(body: Record<string, unknown>): Record<string, unknown> {
  const amount = ethers.BigNumber.from(body.amount as string);
  const exactInput = body.type === 'EXACT_INPUT';
  return {
    chainId: body.tokenInChainId,
    requestId: body.requestId,
    quoteId: body.quoteId,
    tokenIn: body.tokenIn,
    tokenOut: body.tokenOut,
    amountIn: exactInput ? amount.toString() : amount.mul(2).toString(),
    amountOut: exactInput ? amount.mul(2).toString() : amount.toString(),
    swapper: body.swapper,
    filler: '0x0000000000000000000000000000000000000001',
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const path = (req.url ?? '').split('?')[0];
  recorded.push({ path, headers: req.headers, body });
  switch (path) {
    case '/json':
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, n: 1 }));
      return;
    case '/text':
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('not json');
      return;
    case '/json-as-text':
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('{"a":1}');
      return;
    case '/empty':
      res.writeHead(200).end();
      return;
    case '/no-content':
      res.writeHead(204).end();
      return;
    case '/not-found':
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'nope' }));
      return;
    case '/server-error':
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('boom');
      return;
    case '/slow':
      setTimeout(() => res.writeHead(200).end('{}'), 300);
      return;
    case '/trickle': {
      // Headers now, then one body byte every 30ms: active the whole time, done after ~240ms.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const parts = ['{', '"', 'a', '"', ':', '1', '}'];
      const timer = setInterval(() => {
        const next = parts.shift();
        if (next === undefined) {
          clearInterval(timer);
          res.end();
        } else {
          res.write(next);
        }
      }, 30);
      return;
    }
    case '/quote':
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(quoteFor(JSON.parse(body))));
      return;
    default:
      // Block notifications and anything else.
      res.writeHead(200).end();
  }
}

beforeAll(async () => {
  server = http.createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // A port that was just free and is now closed: connecting to it is refused.
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  closedPortUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  recorded.length = 0;
});

type Outcome =
  | { kind: 'resolved'; status: number; data: unknown }
  | {
      kind: 'rejected';
      isAxiosError: boolean;
      code?: string;
      message: string;
      asString: string;
      responseStatus?: number;
      responseData?: unknown;
    };

async function outcomeOf(client: WebhookHttp, url: string, timeout = 500): Promise<Outcome> {
  try {
    const res = await client.post(url, { hello: 'world' }, { timeout });
    return { kind: 'resolved', status: res.status, data: res.data };
  } catch (e) {
    const err = e as AxiosError;
    return {
      kind: 'rejected',
      isAxiosError: e instanceof AxiosError,
      code: err.code,
      message: err.message,
      // What the quoter writes into the analytics record's `axiosError` field.
      asString: `${e}`,
      responseStatus: err.response?.status,
      responseData: err.response?.data,
    };
  }
}

const clients: Array<[string, () => WebhookHttp]> = [
  ['axios', () => axios],
  ['fetch', () => fetchWebhookHttp()],
];

describe('fetchWebhookHttp resolves and rejects like axios', () => {
  const cases: Array<[string, string, Outcome]> = [
    ['200 JSON', '/json', { kind: 'resolved', status: 200, data: { ok: true, n: 1 } }],
    ['200 non-JSON text', '/text', { kind: 'resolved', status: 200, data: 'not json' }],
    ['200 JSON sent as text/plain', '/json-as-text', { kind: 'resolved', status: 200, data: { a: 1 } }],
    ['200 empty body', '/empty', { kind: 'resolved', status: 200, data: '' }],
    ['204 no content', '/no-content', { kind: 'resolved', status: 204, data: '' }],
    [
      '404 with a JSON body',
      '/not-found',
      {
        kind: 'rejected',
        isAxiosError: true,
        code: 'ERR_BAD_REQUEST',
        message: 'Request failed with status code 404',
        asString: 'AxiosError: Request failed with status code 404',
        responseStatus: 404,
        responseData: { error: 'nope' },
      },
    ],
    [
      '500 with a text body',
      '/server-error',
      {
        kind: 'rejected',
        isAxiosError: true,
        code: 'ERR_BAD_RESPONSE',
        message: 'Request failed with status code 500',
        asString: 'AxiosError: Request failed with status code 500',
        responseStatus: 500,
        responseData: 'boom',
      },
    ],
  ];

  it.each(cases)('%s', async (_name, path, expected) => {
    for (const [, make] of clients) {
      expect(await outcomeOf(make(), `${baseUrl}${path}`)).toEqual(expected);
    }
  });

  it('a response slower than the timeout is a timeout (ECONNABORTED), same message', async () => {
    const expected: Outcome = {
      kind: 'rejected',
      isAxiosError: true,
      code: 'ECONNABORTED',
      message: 'timeout of 50ms exceeded',
      asString: 'AxiosError: timeout of 50ms exceeded',
      responseStatus: undefined,
      responseData: undefined,
    };
    for (const [, make] of clients) {
      expect(await outcomeOf(make(), `${baseUrl}/slow`, 50)).toEqual(expected);
    }
  });

  it('a refused connection is a network error with the same code and message', async () => {
    const [viaAxios, viaFetch] = await Promise.all(clients.map(([, make]) => outcomeOf(make(), closedPortUrl)));
    expect(viaAxios).toMatchObject({ kind: 'rejected', isAxiosError: true, code: 'ECONNREFUSED' });
    expect(viaFetch).toEqual(viaAxios);
  });

  it('differs on purpose: a body still trickling in at the deadline times out on fetch', async () => {
    // Axios's timeout restarts on socket activity, so the trickle outlasts a 100ms timeout.
    // fetch's deadline covers the whole request, so it doesn't.
    expect(await outcomeOf(axios, `${baseUrl}/trickle`, 100)).toEqual({
      kind: 'resolved',
      status: 200,
      data: { a: 1 },
    });
    expect(await outcomeOf(fetchWebhookHttp(), `${baseUrl}/trickle`, 100)).toMatchObject({
      kind: 'rejected',
      code: 'ECONNABORTED',
    });
  });
});

describe('fetchWebhookHttp sends what axios sends', () => {
  async function requestSeenBy(client: WebhookHttp, headers?: Record<string, string>): Promise<RecordedRequest> {
    recorded.length = 0;
    await client.post(`${baseUrl}/json`, { requestId: 'r1', amount: '10' }, { timeout: 500, headers });
    return recorded[0];
  }

  it('same JSON body, Content-Type and Accept', async () => {
    const viaAxios = await requestSeenBy(axios);
    const viaFetch = await requestSeenBy(fetchWebhookHttp());
    expect(viaFetch.body).toEqual(viaAxios.body);
    expect(viaFetch.headers['content-type']).toEqual(viaAxios.headers['content-type']);
    expect(viaFetch.headers['accept']).toEqual(viaAxios.headers['accept']);
  });

  it('per-endpoint headers are sent, and replace a default of the same name in any case', async () => {
    const endpointHeaders = { 'x-api-key': 'secret', 'content-type': 'application/json; charset=utf-8' };
    const viaAxios = await requestSeenBy(axios, endpointHeaders);
    const viaFetch = await requestSeenBy(fetchWebhookHttp(), endpointHeaders);
    expect(viaFetch.headers['x-api-key']).toEqual('secret');
    expect(viaFetch.headers['x-api-key']).toEqual(viaAxios.headers['x-api-key']);
    expect(viaFetch.headers['content-type']).toEqual(viaAxios.headers['content-type']);
  });

  it('differs on purpose: User-Agent is no longer axios/<version>', async () => {
    const viaFetch = await requestSeenBy(fetchWebhookHttp());
    expect(viaFetch.headers['user-agent']).not.toMatch(/^axios\//);
  });
});

describe('WebhookQuoter classifies every endpoint the same on either client', () => {
  const now = Math.floor(Date.now() / 1000);
  // Built per run: the server's port is only known once it's listening.
  const endpointsAt = (base: string): WebhookConfiguration[] => [
    { name: 'quotes', endpoint: `${base}/quote`, headers: {}, hash: '0xq' },
    { name: 'declines', endpoint: `${base}/no-content`, headers: {}, hash: '0xd' },
    { name: 'errors', endpoint: `${base}/server-error`, headers: {}, hash: '0xe' },
    { name: 'slow', endpoint: `${base}/slow`, headers: {}, hash: '0xs', overrides: { timeout: 50 } },
    { name: 'benched', endpoint: `${base}/notify`, headers: { 'x-api-key': 'k' }, hash: '0xb' },
  ];

  const request = new QuoteRequest({
    tokenInChainId: 1,
    tokenOutChainId: 1,
    requestId: 'a83f397c-8ef4-4801-a9b7-6e79155049f6',
    swapper: '0x0000000000000000000000000000000000000000',
    tokenIn: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    tokenOut: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    amount: ethers.utils.parseEther('1'),
    type: TradeType.EXACT_INPUT,
    numOutputs: 1,
    protocol: ProtocolVersion.V2,
  });

  async function runWith(client: WebhookHttp) {
    const configs = endpointsAt(baseUrl);
    const benched = configs.find((c) => c.name === 'benched')!;
    const breaker = new MockV2CircuitBreakerConfigurationProvider(
      configs.map((c) => c.endpoint),
      new Map([
        [
          benched.endpoint,
          {
            blockUntilTimestamp: now + 100000,
            fadeWindowStart: now,
            lastExaminedTimestamp: now,
            consecutiveBlocks: 1,
            consecutiveCleanRuns: 0,
          },
        ],
      ])
    );
    const logger = {
      child: () => logger,
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as any;
    const analytics = new FakeAnalyticsLogger();
    const fakes = fakeContext('test');
    recorded.length = 0;

    const quoter = new WebhookQuoter(logger, analytics, new MockWebhookConfigurationProvider(configs), breaker, client);
    const quotes = await quoter.quote(fakes.ctx, request);
    // Block notifications are fire-and-forget; give them a moment to land.
    await new Promise((r) => setTimeout(r, 50));

    const byEndpoint = Object.fromEntries(
      analytics.events
        .filter((e) => e.eventType === AnalyticsEventType.WEBHOOK_RESPONSE)
        .map((e) => {
          const p = e.eventProperties as Record<string, unknown>;
          return [p.name, { responseType: p.responseType, status: p.status, axiosError: p.axiosError }];
        })
    );
    const notifications = recorded
      .filter((r) => r.path === '/notify')
      .map((r) => ({ body: r.body, apiKey: r.headers['x-api-key'] }));
    return {
      quoteCount: quotes.length,
      byEndpoint,
      metricNames: fakes.metrics.names().slice().sort(),
      notifications,
    };
  }

  it('same quotes, analytics records, metrics and block notifications', async () => {
    const viaAxios = await runWith(axios);
    const viaFetch = await runWith(fetchWebhookHttp());

    expect(viaAxios.quoteCount).toEqual(1);
    expect(viaAxios.byEndpoint).toEqual({
      quotes: { responseType: 'OK', status: 200, axiosError: undefined },
      declines: { responseType: 'NON_QUOTE', status: 204, axiosError: undefined },
      errors: {
        responseType: 'HTTP_ERROR',
        status: 500,
        axiosError: 'AxiosError: Request failed with status code 500',
      },
      slow: { responseType: 'TIMEOUT', status: undefined, axiosError: 'AxiosError: timeout of 50ms exceeded' },
    });
    expect(viaAxios.notifications).toEqual([
      { body: JSON.stringify({ blockUntilTimestamp: now + 100000 }), apiKey: 'k' },
    ]);

    expect(viaFetch).toEqual(viaAxios);
  });
});

describe('selectWebhookHttp', () => {
  const log = { info: jest.fn() } as any;

  it('uses fetch only when WEBHOOK_HTTP_CLIENT is fetch', () => {
    expect(selectWebhookHttp(log, { [WEBHOOK_HTTP_CLIENT_ENV]: 'fetch' })).toBeDefined();
    expect(log.info).toHaveBeenLastCalledWith({ webhookHttpClient: 'fetch' }, 'Webhook HTTP client');
  });

  it.each([['axios'], ['unset'], ['FETCH'], ['anything else']])('keeps axios for %s', (value) => {
    const env = value === 'unset' ? {} : { [WEBHOOK_HTTP_CLIENT_ENV]: value };
    expect(selectWebhookHttp(log, env)).toBeUndefined();
    expect(log.info).toHaveBeenLastCalledWith({ webhookHttpClient: 'axios' }, 'Webhook HTTP client');
  });
});
