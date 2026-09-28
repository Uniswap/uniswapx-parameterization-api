import { TradeType } from '@uniswap/sdk-core';
import { CosignedV2DutchOrder } from '@uniswap/uniswapx-sdk';
import axios, { AxiosError } from 'axios';
import { default as Logger } from 'bunyan';
import { ethers } from 'ethers';
import http, { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { AnalyticsEventType, QuoteRequest } from '../../lib/entities';
import { selectWebhookHttp } from '../../lib/handlers/shared/quote-injector';
import {
  MockWebhookConfigurationProvider,
  OrderServiceHttp,
  ProtocolVersion,
  selectOrderServiceHttp,
  UniswapXServiceProvider,
  WebhookConfiguration,
} from '../../lib/providers';
import { MockV2CircuitBreakerConfigurationProvider } from '../../lib/providers/circuit-breaker/mock';
import { WebhookHttp, WebhookQuoter } from '../../lib/quoters';
import { fetchHttp, ORDER_SERVICE_HTTP_CLIENT_ENV, WEBHOOK_HTTP_CLIENT_ENV } from '../../lib/util/fetch-http';
import { FakeAnalyticsLogger, fakeContext } from '../fakes';

// Every test here runs both clients against the same real HTTP server and asserts they agree.
// The callers' classification of an outcome (the quoter's quote / non-quote / timeout / error and
// the analytics records it writes; the order post's accepted / rejected / reconciled) is keyed off
// what axios resolves and rejects, so "the same" is the contract.

interface RecordedRequest {
  method: string;
  // Path plus query string, as the server received it.
  url: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const ORDER_HASH = '0x' + 'ab'.repeat(32);

const TRICKLE_GAP_MS = 40;
const TRICKLE_TIMEOUT_MS = 200;

const recorded: RecordedRequest[] = [];
// How the fake order service treats the next order post: accept it, reject it, or drop the
// connection without answering (the "did it land?" case). The status read finds a dropped post's
// order only when `droppedPostLands` is set.
let orderPostMode: 'accept' | 'reject' | 'drop' = 'accept';
let droppedPostLands = false;
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
  const url = req.url ?? '';
  const path = url.split('?')[0];
  recorded.push({ method: req.method ?? '', url, path, headers: req.headers, body });
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
      // Headers now, then one body byte every 40ms: the socket is never idle for long, but the
      // whole body takes ~480ms. JSON allows the trailing spaces that stretch it out.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const parts = [...'{"a":1}', ...' '.repeat(5)];
      const timer = setInterval(() => {
        const next = parts.shift();
        if (next === undefined) {
          clearInterval(timer);
          res.end();
        } else {
          res.write(next);
        }
      }, TRICKLE_GAP_MS);
      return;
    }
    case '/dutch-auction/order':
      if (orderPostMode === 'drop') {
        req.socket.destroy();
      } else if (orderPostMode === 'reject') {
        res
          .writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ errorCode: 'VALIDATION_ERROR', detail: 'Order expired' }));
      } else {
        res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ hash: ORDER_HASH }));
      }
      return;
    case '/dutch-auction/orders': {
      const query = new URL(url, 'http://x').searchParams;
      const hashes = query.get('orderHashes')?.split(',') ?? (droppedPostLands ? [query.get('orderHash')] : []);
      const orders = hashes.map((orderHash) => ({ orderHash, orderStatus: 'filled', fillBlock: 7 }));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ orders }));
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
  orderPostMode = 'accept';
  droppedPostLands = false;
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
  ['fetch', () => fetchHttp()],
];

describe('fetchHttp resolves and rejects like axios', () => {
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
    // Axios's timeout restarts on socket activity: 40ms gaps sit far inside a 200ms timeout, so it
    // resolves. fetch's deadline covers the whole ~480ms body, so it times out. Both margins are
    // wide enough that a slow CI runner can't flip either result.
    expect(await outcomeOf(axios, `${baseUrl}/trickle`, TRICKLE_TIMEOUT_MS)).toEqual({
      kind: 'resolved',
      status: 200,
      data: { a: 1 },
    });
    expect(await outcomeOf(fetchHttp(), `${baseUrl}/trickle`, TRICKLE_TIMEOUT_MS)).toMatchObject({
      kind: 'rejected',
      code: 'ECONNABORTED',
    });
  });
});

describe('fetchHttp sends what axios sends', () => {
  async function requestSeenBy(client: WebhookHttp, headers?: Record<string, string>): Promise<RecordedRequest> {
    recorded.length = 0;
    await client.post(`${baseUrl}/json`, { requestId: 'r1', amount: '10' }, { timeout: 500, headers });
    return recorded[0];
  }

  it('same JSON body, Content-Type and Accept', async () => {
    const viaAxios = await requestSeenBy(axios);
    const viaFetch = await requestSeenBy(fetchHttp());
    expect(viaFetch.body).toEqual(viaAxios.body);
    expect(viaFetch.headers['content-type']).toEqual(viaAxios.headers['content-type']);
    expect(viaFetch.headers['accept']).toEqual(viaAxios.headers['accept']);
  });

  it('per-endpoint headers are sent, and replace a default of the same name in any case', async () => {
    const endpointHeaders = { 'x-api-key': 'secret', 'content-type': 'application/json; charset=utf-8' };
    const viaAxios = await requestSeenBy(axios, endpointHeaders);
    const viaFetch = await requestSeenBy(fetchHttp(), endpointHeaders);
    expect(viaFetch.headers['x-api-key']).toEqual('secret');
    expect(viaFetch.headers['x-api-key']).toEqual(viaAxios.headers['x-api-key']);
    expect(viaFetch.headers['content-type']).toEqual(viaAxios.headers['content-type']);
  });

  it('differs on purpose: User-Agent is no longer axios/<version>', async () => {
    const viaFetch = await requestSeenBy(fetchHttp());
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
    const viaFetch = await runWith(fetchHttp());

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

describe('the order-service client behaves the same on either client', () => {
  const logger = Logger.createLogger({ name: 'test' });
  logger.level(Logger.FATAL);

  // ORDER_TYPE_MAP looks the sdk class up via order.constructor, so the stub shares its prototype.
  function orderStub(): CosignedV2DutchOrder {
    const order = Object.create(CosignedV2DutchOrder.prototype);
    order.hash = () => ORDER_HASH;
    order.serialize = () => '0xencoded';
    order.chainId = 1;
    return order;
  }

  // What the order service sees: method, URL with query, body and the content headers.
  const seen = () =>
    recorded.map((r) => ({
      method: r.method,
      url: r.url,
      body: r.body,
      contentType: r.headers['content-type'],
      accept: r.headers['accept'],
    }));

  async function postWith(client: OrderServiceHttp) {
    recorded.length = 0;
    const provider = new UniswapXServiceProvider(logger, `${baseUrl}/`, client);
    const result = await provider.postOrder({ order: orderStub(), signature: '0xsig', quoteId: 'q1', requestId: 'r1' });
    return { result, requests: seen() };
  }

  it('an accepted post', async () => {
    const viaAxios = await postWith(axios);
    expect(viaAxios.result).toEqual({ statusCode: 201, data: { hash: ORDER_HASH } });
    expect(await postWith(fetchHttp())).toEqual(viaAxios);
  });

  it('a rejected post passes the service error through', async () => {
    orderPostMode = 'reject';
    const viaAxios = await postWith(axios);
    expect(viaAxios.result).toEqual({ statusCode: 400, errorCode: 'VALIDATION_ERROR', detail: 'Order expired' });
    expect(await postWith(fetchHttp())).toEqual(viaAxios);
  });

  it('a dropped post that landed reconciles to success', async () => {
    orderPostMode = 'drop';
    droppedPostLands = true;
    const viaAxios = await postWith(axios);
    expect(viaAxios.result).toEqual({ statusCode: 201, data: { hash: ORDER_HASH } });
    expect(viaAxios.requests.map((r) => r.method)).toEqual(['POST', 'GET']);
    expect(await postWith(fetchHttp())).toEqual(viaAxios);
  });

  it('a dropped post that did not land reports indeterminate with the hash', async () => {
    orderPostMode = 'drop';
    const viaAxios = await postWith(axios);
    expect(viaAxios.result).toMatchObject({ statusCode: 500, data: { hash: ORDER_HASH } });
    expect(await postWith(fetchHttp())).toEqual(viaAxios);
  });

  it('the status read requests the same URL and parses the same statuses', async () => {
    const hashes = ['0xAA', '0xbb', '0xcc'];
    const readWith = async (client: OrderServiceHttp) => {
      recorded.length = 0;
      const provider = new UniswapXServiceProvider(logger, `${baseUrl}/`, client);
      return { statuses: await provider.getOrdersByHashes(hashes), requests: seen() };
    };
    const viaAxios = await readWith(axios);
    expect(viaAxios.statuses).toEqual(
      hashes.map((h) => ({ orderHash: h.toLowerCase(), orderStatus: 'filled', fillBlock: 7 }))
    );
    // axios keeps the commas literal; the fetch client must request the identical URL.
    expect(viaAxios.requests[0].url).toEqual('/dutch-auction/orders?orderHashes=0xAA,0xbb,0xcc');
    expect(await readWith(fetchHttp())).toEqual(viaAxios);
  });
});

describe('selectOrderServiceHttp', () => {
  const log = { info: jest.fn() } as any;

  it('uses fetch only when ORDER_SERVICE_HTTP_CLIENT is fetch', () => {
    expect(selectOrderServiceHttp(log, { [ORDER_SERVICE_HTTP_CLIENT_ENV]: 'fetch' })).toBeDefined();
    expect(log.info).toHaveBeenLastCalledWith({ orderServiceHttpClient: 'fetch' }, 'Order service HTTP client');
  });

  it.each([['axios'], ['unset'], ['FETCH']])('keeps axios for %s', (value) => {
    const env = value === 'unset' ? {} : { [ORDER_SERVICE_HTTP_CLIENT_ENV]: value };
    expect(selectOrderServiceHttp(log, env)).toBeUndefined();
    expect(log.info).toHaveBeenLastCalledWith({ orderServiceHttpClient: 'axios' }, 'Order service HTTP client');
  });
});
