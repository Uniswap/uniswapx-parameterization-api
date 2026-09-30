import Logger from 'bunyan';
import { execFileSync } from 'child_process';
import fs from 'fs';
import http, { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import https from 'https';
import net, { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { TLSSocket } from 'tls';

import { selectWebhookFetch } from '../../../lib/handlers/shared/quote-injector';
import {
  EGRESS_PROXY_URL_ENV,
  EGRESS_PROXY_WEBHOOK_SHARE_ENV,
  parseEgressProxyShare,
  proxiedFetch,
  splitFetch,
} from '../../../lib/quoters';
import { FetchFn, fetchJson, HttpError, timedFetch } from '../../../lib/util/fetch-http';

// A market-maker stand-in (plain HTTP and HTTPS) and a CONNECT-tunneling forward proxy, all real
// local servers. The proxy behaves like the squid egress proxy for these purposes: it tunnels
// CONNECT to any host:port and answers 503 when the target can't be reached.

interface RecordedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  body: string;
  servername?: string;
}

const recorded: RecordedRequest[] = [];
const tunnels: string[] = [];
// Tunnel sockets leave the proxy server's connection tracking, so they're closed explicitly.
const tunnelSockets: net.Socket[] = [];
let target: http.Server;
let tlsTarget: https.Server;
let proxy: http.Server;
let baseUrl = '';
let tlsPort = 0;
let closedPortUrl = '';
let proxyUrl = '';
let ca = '';

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
  const socket = req.socket as TLSSocket;
  const servername = typeof socket.servername === 'string' ? socket.servername : undefined;
  recorded.push({ path, headers: req.headers, rawHeaders: req.rawHeaders, body, servername });
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

function listen(server: net.Server, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve) => server.listen(0, host, () => resolve((server.address() as AddressInfo).port)));
}

// A throwaway certificate for localhost, so TLS through the tunnel is verified against the
// hostname just as a direct call verifies it. openssl is on every developer machine and CI image.
function selfSignedCertificate(): { key: string; cert: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-proxy-tls-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
    ],
    { stdio: 'ignore' }
  );
  return { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(cert, 'utf8') };
}

beforeAll(async () => {
  target = http.createServer((req, res) => void handle(req, res));
  baseUrl = `http://127.0.0.1:${await listen(target)}`;

  const { key, cert } = selfSignedCertificate();
  ca = cert;
  tlsTarget = https.createServer({ key, cert }, (req, res) => void handle(req, res));
  tlsPort = await listen(tlsTarget, 'localhost');

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
  for (const server of [target, tlsTarget, proxy]) {
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
  | { kind: 'rejected'; errorKind: HttpError['kind'] | 'unexpected'; message: string; status?: number; data?: unknown };

// A webhook call exactly as WebhookQuoter makes it: fetchJson over the given fetch.
async function outcomeOf(fetchFn: FetchFn, url: string, timeoutMs = 500): Promise<Outcome> {
  try {
    const res = await fetchJson<unknown>(fetchFn, url, {
      method: 'POST',
      body: { hello: 'world' },
      headers: { 'x-api-key': 'k' },
      timeoutMs,
    });
    return { kind: 'resolved', status: res.status, data: res.data };
  } catch (e) {
    return e instanceof HttpError
      ? { kind: 'rejected', errorKind: e.kind, message: e.message, status: e.status, data: e.data }
      : { kind: 'rejected', errorKind: 'unexpected', message: String(e) };
  }
}

describe('proxiedFetch', () => {
  const viaProxy = () => proxiedFetch(proxyUrl);

  it.each([['/json'], ['/text'], ['/empty'], ['/no-content'], ['/not-found'], ['/server-error']])(
    '%s resolves or rejects exactly as a direct call does, through a tunnel',
    async (path) => {
      const expected = await outcomeOf(timedFetch, `${baseUrl}${path}`);
      const actual = await outcomeOf(viaProxy(), `${baseUrl}${path}`);
      expect(actual).toEqual(expected);
      expect(tunnels).toEqual([new URL(baseUrl).host]);
    }
  );

  it('sends the market maker byte-for-byte what a direct call sends: same headers, casing, order and user agent', async () => {
    await outcomeOf(timedFetch, `${baseUrl}/json`);
    await outcomeOf(viaProxy(), `${baseUrl}/json`);
    const [viaDirect, proxied] = recorded;
    expect(proxied.body).toEqual(viaDirect.body);
    expect(proxied.rawHeaders).toEqual(viaDirect.rawHeaders);
    expect(viaDirect.rawHeaders).toContain('Content-Type');
    expect(viaDirect.headers['user-agent']).toEqual('node');
  });

  it('keeps the whole-request deadline: a response slower than it is a timeout', async () => {
    const outcome = await outcomeOf(viaProxy(), `${baseUrl}/slow`, 200);
    expect(outcome).toMatchObject({ kind: 'rejected', errorKind: 'timeout', message: 'timeout of 200ms exceeded' });
  });

  it('an unreachable market maker is a network error, not a timeout or an HTTP status', async () => {
    const outcome = await outcomeOf(viaProxy(), `${closedPortUrl}/json`);
    expect(outcome).toMatchObject({ kind: 'rejected', errorKind: 'network', status: undefined });
  });

  it('negotiates TLS over the tunnel with the hostname as the server name', async () => {
    const outcome = await outcomeOf(proxiedFetch(proxyUrl, { tls: { ca } }), `https://localhost:${tlsPort}/json`);
    expect(outcome).toEqual({ kind: 'resolved', status: 200, data: { ok: true } });
    expect(tunnels).toEqual([`localhost:${tlsPort}`]);
    expect(recorded[0].servername).toEqual('localhost');
    expect(recorded[0].headers.host).toEqual(`localhost:${tlsPort}`);
  });
});

describe('splitFetch', () => {
  const direct: FetchFn = async () => new Response('direct');
  const proxied: FetchFn = async () => new Response('proxied');
  // Which fetch answered, and which route the split reported for the call.
  const routeOf = async (fn: FetchFn) => {
    const reported: string[] = [];
    const answered = await (await fn('http://x', {}, { onRoute: (r) => reported.push(r) })).text();
    return `${answered}/${reported.join(',')}`;
  };

  it('sends every call direct at 0% and through the proxy at 100%, reporting the path each time', async () => {
    expect(await routeOf(splitFetch(direct, proxied, 0))).toBe('direct/direct');
    expect(await routeOf(splitFetch(direct, proxied, 100))).toBe('proxied/proxy');
  });

  it('sends a call through the proxy when the draw falls under the share, and reports which', async () => {
    const draws = [0.1, 0.5, 0.29, 0.3];
    const split = splitFetch(direct, proxied, 30, () => draws.shift() ?? 1);
    const routes = [];
    for (let i = 0; i < 4; i++) routes.push(await routeOf(split));
    expect(routes).toEqual(['proxied/proxy', 'direct/direct', 'proxied/proxy', 'direct/direct']);
  });

  it('works for a caller that does not ask for the route', async () => {
    expect(await (await splitFetch(direct, proxied, 100)('http://x')).text()).toBe('proxied');
  });

  it('passes the timeout config through to the chosen fetch', async () => {
    const seen: Array<number | undefined> = [];
    const recording: FetchFn = async (_i, _init, config) => {
      seen.push(config?.timeoutMs);
      return new Response('');
    };
    await splitFetch(recording, recording, 50, () => 0)('http://x', {}, { timeoutMs: 123 });
    await splitFetch(recording, recording, 50, () => 0.9)('http://x', {}, { timeoutMs: 456 });
    expect(seen).toEqual([123, 456]);
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

describe('selectWebhookFetch', () => {
  const log = { info: jest.fn(), warn: jest.fn() };
  const select = (env: NodeJS.ProcessEnv) => selectWebhookFetch(log as unknown as Logger, env);
  beforeEach(() => jest.clearAllMocks());

  it('sends every call through the proxy at 100%', async () => {
    const fetchFn = select({ [EGRESS_PROXY_URL_ENV]: proxyUrl, [EGRESS_PROXY_WEBHOOK_SHARE_ENV]: '100' });
    expect(await outcomeOf(fetchFn, `${baseUrl}/json`)).toMatchObject({ kind: 'resolved', status: 200 });
    expect(tunnels).toHaveLength(1);
    expect(log.info).toHaveBeenLastCalledWith({ egressProxyShare: 100 }, 'Webhook egress');
  });

  it('goes direct with no share, a zero share, or no proxy address', () => {
    for (const env of [
      { [EGRESS_PROXY_URL_ENV]: proxyUrl },
      { [EGRESS_PROXY_URL_ENV]: proxyUrl, [EGRESS_PROXY_WEBHOOK_SHARE_ENV]: '0' },
      { [EGRESS_PROXY_WEBHOOK_SHARE_ENV]: '100' },
      {},
    ]) {
      expect(select(env)).toBe(timedFetch);
      expect(log.info).toHaveBeenLastCalledWith({ egressProxyShare: 0 }, 'Webhook egress');
    }
  });

  it('warns and goes direct on an invalid share', () => {
    const fetchFn = select({ [EGRESS_PROXY_URL_ENV]: proxyUrl, [EGRESS_PROXY_WEBHOOK_SHARE_ENV]: '150' });
    expect(fetchFn).toBe(timedFetch);
    expect(log.warn).toHaveBeenCalledWith({ rawShare: '150' }, expect.stringContaining('Invalid egress proxy share'));
  });
});
