import { TradeType } from '@uniswap/sdk-core';
import { CosignedV2DutchOrder } from '@uniswap/uniswapx-sdk';
import { default as Logger } from 'bunyan';
import { ethers } from 'ethers';
import http, { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { AnalyticsEventType, QuoteRequest } from '../../lib/entities';
import {
  MockWebhookConfigurationProvider,
  ProtocolVersion,
  UniswapXServiceProvider,
  WebhookConfiguration,
} from '../../lib/providers';
import { MockV2CircuitBreakerConfigurationProvider } from '../../lib/providers/circuit-breaker/mock';
import { WebhookQuoter } from '../../lib/quoters';
import { fetchJson, HttpError, timedFetch } from '../../lib/util/fetch-http';
import { FakeAnalyticsLogger, fakeContext } from '../fakes';

// Every test here runs the client against a real local HTTP server. The expected values are the
// ones the service produced on axios, which its analytics records, logs and dashboards were built
// on: the callers' classification of an outcome (the quoter's quote / non-quote / timeout / error;
// the order post's accepted / rejected / reconciled) is keyed off how the client resolves and
// rejects, so those are pinned exactly.

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
      isHttpError: boolean;
      code?: string;
      message: string;
      asString: string;
      errorKind: string;
      status?: number;
      data?: unknown;
    };

async function outcomeOf(url: string, timeout = 500): Promise<Outcome> {
  try {
    const res = await fetchJson(timedFetch, url, { method: 'POST', body: { hello: 'world' }, timeoutMs: timeout });
    return { kind: 'resolved', status: res.status, data: res.data };
  } catch (e) {
    const err = e as HttpError;
    return {
      kind: 'rejected',
      isHttpError: e instanceof HttpError,
      errorKind: err.kind,
      message: err.message,
      // What the quoter writes into the analytics record's `axiosError` field.
      asString: `${e}`,
      status: err.status,
      data: err.data,
    };
  }
}

describe('fetchJson resolves and rejects', () => {
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
        isHttpError: true,
        errorKind: 'status',
        message: 'Request failed with status code 404',
        asString: 'HttpError: Request failed with status code 404',
        status: 404,
        data: { error: 'nope' },
      },
    ],
    [
      '500 with a text body',
      '/server-error',
      {
        kind: 'rejected',
        isHttpError: true,
        errorKind: 'status',
        message: 'Request failed with status code 500',
        asString: 'HttpError: Request failed with status code 500',
        status: 500,
        data: 'boom',
      },
    ],
  ];

  it.each(cases)('%s', async (_name, path, expected) => {
    expect(await outcomeOf(`${baseUrl}${path}`)).toEqual(expected);
  });

  it('a response slower than the timeout is a timeout with no status', async () => {
    expect(await outcomeOf(`${baseUrl}/slow`, 50)).toEqual({
      kind: 'rejected',
      isHttpError: true,
      errorKind: 'timeout',
      message: 'timeout of 50ms exceeded',
      asString: 'HttpError: timeout of 50ms exceeded',
      status: undefined,
      data: undefined,
    });
  });

  it('a refused connection is a network error carrying the socket message', async () => {
    const outcome = await outcomeOf(closedPortUrl);
    expect(outcome).toMatchObject({
      kind: 'rejected',
      isHttpError: true,
      errorKind: 'network',
      status: undefined,
    });
    expect(outcome.kind === 'rejected' && outcome.asString).toMatch(
      /^HttpError: connect ECONNREFUSED 127\.0\.0\.1:\d+$/
    );
  });

  it('the deadline covers the whole body: one still trickling in when it passes times out', async () => {
    // 40ms gaps would each sit well inside the 200ms timeout, but the whole ~480ms body does not.
    expect(await outcomeOf(`${baseUrl}/trickle`, TRICKLE_TIMEOUT_MS)).toMatchObject({
      kind: 'rejected',
      errorKind: 'timeout',
    });
  });
});

describe('fetchJson sends', () => {
  async function postSeen(headers?: Record<string, string>): Promise<RecordedRequest> {
    recorded.length = 0;
    await fetchJson(timedFetch, `${baseUrl}/json`, {
      method: 'POST',
      body: { requestId: 'r1', amount: '10' },
      headers,
      timeoutMs: 500,
    });
    return recorded[0];
  }

  it('the JSON body with JSON Content-Type and the Accept header servers have always seen', async () => {
    const seen = await postSeen();
    expect(seen.body).toEqual('{"requestId":"r1","amount":"10"}');
    expect(seen.headers['content-type']).toEqual('application/json');
    expect(seen.headers['accept']).toEqual('application/json, text/plain, */*');
  });

  it('per-endpoint headers, replacing a default of the same name in any case', async () => {
    const seen = await postSeen({ 'x-api-key': 'secret', 'content-type': 'application/json; charset=utf-8' });
    expect(seen.headers['x-api-key']).toEqual('secret');
    expect(seen.headers['content-type']).toEqual('application/json; charset=utf-8');
  });

  it('a GET with Accept only and no body', async () => {
    recorded.length = 0;
    await fetchJson(timedFetch, `${baseUrl}/json?x=1`, { method: 'GET' });
    expect(recorded[0]).toMatchObject({ method: 'GET', url: '/json?x=1', body: '' });
    expect(recorded[0].headers['content-type']).toBeUndefined();
    expect(recorded[0].headers['accept']).toEqual('application/json, text/plain, */*');
  });
});

describe('WebhookQuoter on the fetch client', () => {
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

  // No client injected: this is the quoter's default, the one the Lambdas run.
  it('classifies every endpoint, records it in analytics and notifies the benched one', async () => {
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

    const quoter = new WebhookQuoter(logger, analytics, new MockWebhookConfigurationProvider(configs), breaker);
    const quotes = await quoter.quote(fakes.ctx, request);
    // Block notifications are fire-and-forget; give them a moment to land.
    await new Promise((r) => setTimeout(r, 50));

    expect(quotes).toHaveLength(1);
    const byEndpoint = Object.fromEntries(
      analytics.events
        .filter((e) => e.eventType === AnalyticsEventType.WEBHOOK_RESPONSE)
        .map((e) => {
          const p = e.eventProperties as Record<string, unknown>;
          return [p.name, { responseType: p.responseType, status: p.status, axiosError: p.axiosError }];
        })
    );
    expect(byEndpoint).toEqual({
      quotes: { responseType: 'OK', status: 200, axiosError: undefined },
      declines: { responseType: 'NON_QUOTE', status: 204, axiosError: undefined },
      errors: { responseType: 'HTTP_ERROR', status: 500, axiosError: 'HttpError: Request failed with status code 500' },
      slow: { responseType: 'TIMEOUT', status: undefined, axiosError: 'HttpError: timeout of 50ms exceeded' },
    });
    expect(
      recorded.filter((r) => r.path === '/notify').map((r) => ({ body: r.body, apiKey: r.headers['x-api-key'] }))
    ).toEqual([{ body: JSON.stringify({ blockUntilTimestamp: now + 100000 }), apiKey: 'k' }]);
  });
});

describe('UniswapXServiceProvider on the fetch client', () => {
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
      body: r.body === '' ? undefined : JSON.parse(r.body),
      contentType: r.headers['content-type'],
    }));

  const POSTED = {
    method: 'POST',
    url: '/dutch-auction/order',
    body: {
      encodedOrder: '0xencoded',
      signature: '0xsig',
      chainId: 1,
      quoteId: 'q1',
      requestId: 'r1',
      orderType: 'Dutch_V2',
    },
    contentType: 'application/json',
  };
  const RECONCILE_READ = {
    method: 'GET',
    url: `/dutch-auction/orders?chainId=1&orderHash=${ORDER_HASH}`,
    body: undefined,
    contentType: undefined,
  };

  // No client injected: this is the provider's default, the one the Lambdas run.
  async function post() {
    recorded.length = 0;
    const provider = new UniswapXServiceProvider(logger, `${baseUrl}/`);
    const result = await provider.postOrder({ order: orderStub(), signature: '0xsig', quoteId: 'q1', requestId: 'r1' });
    return { result, requests: seen() };
  }

  it('an accepted post', async () => {
    expect(await post()).toEqual({ result: { statusCode: 201, data: { hash: ORDER_HASH } }, requests: [POSTED] });
  });

  it('a rejected post passes the service error through', async () => {
    orderPostMode = 'reject';
    expect(await post()).toEqual({
      result: { statusCode: 400, errorCode: 'VALIDATION_ERROR', detail: 'Order expired' },
      requests: [POSTED],
    });
  });

  it('a dropped post that landed reconciles to success', async () => {
    orderPostMode = 'drop';
    droppedPostLands = true;
    expect(await post()).toEqual({
      result: { statusCode: 201, data: { hash: ORDER_HASH } },
      requests: [POSTED, RECONCILE_READ],
    });
  });

  it('a dropped post that did not land reports indeterminate with the hash', async () => {
    orderPostMode = 'drop';
    const { result, requests } = await post();
    expect(result).toMatchObject({ statusCode: 500, data: { hash: ORDER_HASH } });
    expect(requests).toEqual([POSTED, RECONCILE_READ]);
  });

  it('the status read keeps the commas literal and parses the statuses', async () => {
    recorded.length = 0;
    const hashes = ['0xAA', '0xbb', '0xcc'];
    const statuses = await new UniswapXServiceProvider(logger, `${baseUrl}/`).getOrdersByHashes(hashes);
    expect(statuses).toEqual(hashes.map((h) => ({ orderHash: h.toLowerCase(), orderStatus: 'filled', fillBlock: 7 })));
    expect(seen()).toEqual([
      {
        method: 'GET',
        url: '/dutch-auction/orders?orderHashes=0xAA,0xbb,0xcc',
        body: undefined,
        contentType: undefined,
      },
    ]);
  });
});
