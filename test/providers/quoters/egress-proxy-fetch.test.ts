import { AxiosError } from 'axios';
import Logger from 'bunyan';
import http, { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import net, { AddressInfo } from 'net';

import { selectWebhookHttp } from '../../../lib/handlers/shared/quote-injector';
import {
  EGRESS_PROXY_URL_ENV,
  EGRESS_PROXY_WEBHOOK_SHARE_ENV,
  parseEgressProxyShare,
  proxiedFetch,
  splitFetch,
  WebhookHttp,
} from '../../../lib/quoters';
import { FetchFn, fetchHttp, WEBHOOK_HTTP_CLIENT_ENV } from '../../../lib/util/fetch-http';

// A market-maker stand-in and a CONNECT-tunneling forward proxy, both real local servers. The
// proxy behaves like the squid egress proxy for these purposes: it tunnels CONNECT to any
// host:port and answers 503 when the target can't be reached.

interface RecordedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const recorded: RecordedRequest[] = [];
const tunnels: string[] = [];
// Tunnel sockets leave the proxy server's connection tracking, so they're closed explicitly.
const tunnelSockets: net.Socket[] = [];
let target: http.Server;
let proxy: http.Server;
let baseUrl = '';
let closedPortUrl = '';
let proxyUrl = '';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const path = (req.url ?? '').split('?')[0];
  recorded.push({ path, headers: req.headers, body });
  switch (path) {
    case '/json':
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    case '/text':
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('not json');
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
    default:
      res.writeHead(200).end();
  }
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

beforeAll(async () => {
  target = http.createServer((req, res) => void handle(req, res));
  baseUrl = `http://127.0.0.1:${await listen(target)}`;

  const probe = http.createServer();
  closedPortUrl = `http://127.0.0.1:${await listen(probe)}`;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  proxy = http.createServer((_req, res) => res.writeHead(405).end());
  proxy.on('connect', (req: IncomingMessage, client: net.Socket, head: Buffer) => {
    tunnels.push(req.url ?? '');
    tunnelSockets.push(client);
    const [host, port] = (req.url ?? '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      tunnelSockets.push(upstream);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'));
    client.on('error', () => upstream.destroy());
  });
  proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
});

afterAll(async () => {
  for (const socket of tunnelSockets) socket.destroy();
  for (const server of [target, proxy]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

beforeEach(() => {
  recorded.length = 0;
  tunnels.length = 0;
});

type Outcome =
  | { kind: 'resolved'; status: number; data: unknown }
  | { kind: 'rejected'; isAxiosError: boolean; code?: string; message: string; responseStatus?: number };

async function outcomeOf(client: WebhookHttp, url: string, timeout = 500): Promise<Outcome> {
  try {
    const res = await client.post(url, { hello: 'world' }, { timeout, headers: { 'x-api-key': 'k' } });
    return { kind: 'resolved', status: res.status, data: res.data };
  } catch (e) {
    const err = e as AxiosError;
    return {
      kind: 'rejected',
      isAxiosError: e instanceof AxiosError,
      code: err.code,
      message: err.message,
      responseStatus: err.response?.status,
    };
  }
}

describe('proxiedFetch', () => {
  const direct = () => fetchHttp();
  const viaProxy = () => fetchHttp(proxiedFetch(proxyUrl));

  it.each([['/json'], ['/text'], ['/empty'], ['/no-content'], ['/not-found'], ['/server-error']])(
    '%s resolves or rejects exactly as a direct call does, through a tunnel',
    async (path) => {
      const expected = await outcomeOf(direct(), `${baseUrl}${path}`);
      const actual = await outcomeOf(viaProxy(), `${baseUrl}${path}`);
      expect(actual).toEqual(expected);
      expect(tunnels).toEqual([new URL(baseUrl).host]);
    }
  );

  it('delivers the same method, body and headers to the market maker', async () => {
    await outcomeOf(direct(), `${baseUrl}/json`);
    await outcomeOf(viaProxy(), `${baseUrl}/json`);
    const [viaDirect, proxied] = recorded;
    expect(proxied.body).toEqual(viaDirect.body);
    for (const name of ['content-type', 'accept', 'x-api-key', 'host']) {
      expect(proxied.headers[name]).toEqual(viaDirect.headers[name]);
    }
  });

  it('keeps the timeout: a response slower than the deadline is a timeout (ECONNABORTED)', async () => {
    const outcome = await outcomeOf(viaProxy(), `${baseUrl}/slow`, 200);
    expect(outcome).toMatchObject({ kind: 'rejected', isAxiosError: true, code: 'ECONNABORTED' });
  });

  it('an unreachable market maker is a network error, not a timeout or an HTTP response', async () => {
    const outcome = await outcomeOf(viaProxy(), `${closedPortUrl}/json`);
    expect(outcome).toMatchObject({ kind: 'rejected', isAxiosError: true, responseStatus: undefined });
    expect(outcome).not.toMatchObject({ code: 'ECONNABORTED' });
  });
});

describe('splitFetch', () => {
  const direct: FetchFn = async () => new Response('direct');
  const proxied: FetchFn = async () => new Response('proxied');
  const routeOf = async (fn: FetchFn) => (await fn('http://x', {})).text();

  it('returns the direct client at 0% and the proxied client at 100%', () => {
    expect(splitFetch(direct, proxied, 0)).toBe(direct);
    expect(splitFetch(direct, proxied, 100)).toBe(proxied);
  });

  it('sends a call through the proxy when the draw falls under the share', async () => {
    const draws = [0.1, 0.5, 0.29, 0.3];
    const split = splitFetch(direct, proxied, 30, () => draws.shift() ?? 1);
    const routes = [];
    for (let i = 0; i < 4; i++) routes.push(await routeOf(split));
    expect(routes).toEqual(['proxied', 'direct', 'proxied', 'direct']);
  });
});

describe('parseEgressProxyShare', () => {
  it.each([
    ['0', 0],
    ['5', 5],
    ['100', 100],
  ])('accepts %s', (raw, share) => expect(parseEgressProxyShare(raw)).toBe(share));

  it.each([['101'], ['-1'], ['1.5'], ['abc'], [''], [' 5'], [undefined]])('rejects %s', (raw) =>
    expect(parseEgressProxyShare(raw)).toBeUndefined()
  );
});

describe('selectWebhookHttp with the egress proxy', () => {
  const log = { info: jest.fn(), warn: jest.fn() };
  const select = (env: NodeJS.ProcessEnv) => selectWebhookHttp(log as unknown as Logger, env);
  const defined = (client: WebhookHttp | undefined): WebhookHttp => {
    if (!client) throw new Error('expected the fetch client');
    return client;
  };
  beforeEach(() => jest.clearAllMocks());

  const fetchEnv = (extra: Record<string, string>) => ({ [WEBHOOK_HTTP_CLIENT_ENV]: 'fetch', ...extra });

  it('sends every call through the proxy at 100%', async () => {
    const client = select(fetchEnv({ [EGRESS_PROXY_URL_ENV]: proxyUrl, [EGRESS_PROXY_WEBHOOK_SHARE_ENV]: '100' }));
    expect(await outcomeOf(defined(client), `${baseUrl}/json`)).toMatchObject({ kind: 'resolved', status: 200 });
    expect(tunnels).toHaveLength(1);
    expect(log.info).toHaveBeenLastCalledWith(
      { webhookHttpClient: 'fetch', egressProxyShare: 100 },
      'Webhook HTTP client'
    );
  });

  it('goes direct with no share, a zero share, or no proxy address', async () => {
    for (const env of [
      fetchEnv({ [EGRESS_PROXY_URL_ENV]: proxyUrl }),
      fetchEnv({ [EGRESS_PROXY_URL_ENV]: proxyUrl, [EGRESS_PROXY_WEBHOOK_SHARE_ENV]: '0' }),
      fetchEnv({ [EGRESS_PROXY_WEBHOOK_SHARE_ENV]: '100' }),
    ]) {
      const client = select(env);
      expect(await outcomeOf(defined(client), `${baseUrl}/json`)).toMatchObject({ kind: 'resolved' });
      expect(log.info).toHaveBeenLastCalledWith(
        { webhookHttpClient: 'fetch', egressProxyShare: 0 },
        'Webhook HTTP client'
      );
    }
    expect(tunnels).toHaveLength(0);
  });

  it('warns and goes direct on an invalid share', async () => {
    const client = select(fetchEnv({ [EGRESS_PROXY_URL_ENV]: proxyUrl, [EGRESS_PROXY_WEBHOOK_SHARE_ENV]: '150' }));
    await outcomeOf(defined(client), `${baseUrl}/json`);
    expect(tunnels).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith({ rawShare: '150' }, expect.stringContaining('Invalid egress proxy share'));
  });

  it('ignores the share on the axios client, with a warning', () => {
    const client = select({
      [EGRESS_PROXY_URL_ENV]: proxyUrl,
      [EGRESS_PROXY_WEBHOOK_SHARE_ENV]: '100',
    });
    expect(client).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith({ share: 100 }, expect.stringContaining('needs the fetch webhook client'));
    expect(log.info).toHaveBeenLastCalledWith(
      { webhookHttpClient: 'axios', egressProxyShare: 0 },
      'Webhook HTTP client'
    );
  });
});
