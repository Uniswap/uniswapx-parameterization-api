import { FetchFn } from '../../lib/util/fetch-http';

/** A scripted server reply: a status (default 200) and a body, or an error for fetch to reject with. */
export type FetchReply = { status?: number; data?: unknown } | Error;

/**
 * One request as a fake saw it, unpacked back into the JSON view the caller wrote: the parsed
 * body, and only the headers the caller added. The JSON defaults every request carries are
 * pinned against a real server in test/util/fetch-http.test.ts.
 */
export interface RecordedFetch {
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string>;
  timeoutMs?: number;
}

/**
 * What fetch rejects with when its timeout fires: a DOMException named TimeoutError. Built as an
 * Error with that name because a DOMException isn't an Error in jest's realm; the client matches
 * on the name either way.
 */
export function fetchTimeoutError(): Error {
  return Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
}

/** What fetch rejects with when the connection fails. */
export function fetchNetworkError(message = 'connect ECONNREFUSED 10.0.0.1:443'): Error {
  // The ES2020 lib has no `cause` option on the Error constructors.
  return Object.assign(new TypeError('fetch failed'), { cause: new Error(message) });
}

const JSON_DEFAULTS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/json',
};

function record(input: string, init?: RequestInit, config?: { timeoutMs?: number }): RecordedFetch {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => {
    if (JSON_DEFAULTS[name] !== value) {
      headers[name] = value;
    }
  });
  return {
    method: init?.method ?? 'GET',
    url: input,
    ...(typeof init?.body === 'string' && { body: JSON.parse(init.body) }),
    headers,
    ...(config?.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
  };
}

function toResponse({ status = 200, data }: { status?: number; data?: unknown }): Response {
  // A 204/205/304 can't carry a body (fetch drops one a server sends anyway).
  const bodyless = status === 204 || status === 205 || status === 304;
  const body = bodyless || data === undefined ? null : typeof data === 'string' ? data : JSON.stringify(data);
  return new Response(body, { status });
}

/**
 * Scripted fetch for the order-service client. Queue replies per method with `reply`, then assert
 * on `calls`. A request with nothing queued fails loudly, so a test can't silently exercise a
 * request it didn't expect.
 */
export class FakeFetch {
  public readonly calls: RecordedFetch[] = [];
  private readonly queues: Record<string, FetchReply[]> = { GET: [], POST: [] };

  public reply(method: 'GET' | 'POST', ...replies: FetchReply[]): this {
    this.queues[method].push(...replies);
    return this;
  }

  public callsTo(method: 'GET' | 'POST'): RecordedFetch[] {
    return this.calls.filter((c) => c.method === method);
  }

  public readonly fetch: FetchFn = async (input, init, config) => {
    const call = record(input, init, config);
    this.calls.push(call);
    const next = this.queues[call.method]?.shift();
    if (next === undefined) {
      throw new Error(`FakeFetch: unexpected ${call.method} ${call.url}`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return toResponse(next);
  };
}

/** The per-call view a `jsonFetchMock` hands its mock: the parsed body, added headers and timeout. */
export type JsonPostMock = jest.Mock<
  Promise<{ status?: number; data?: unknown }>,
  [url: string, body: unknown, options: { headers: Record<string, string>; timeoutMs?: number }]
>;

/**
 * A fetch backed by a jest mock of `(url, body, { headers, timeoutMs })`, for tests that script
 * replies per call with mockImplementation. The mock answers with `{ status, data }` or rejects with
 * what fetch would reject with (see fetchTimeoutError / fetchNetworkError).
 */
export function jsonFetchMock(): { post: JsonPostMock; fetch: FetchFn } {
  const post: JsonPostMock = jest.fn();
  const fetch: FetchFn = async (input, init, config) => {
    const { url, body, headers, timeoutMs } = record(input, init, config);
    // A call the test didn't script (the mock returns undefined) gets an empty 200.
    return toResponse((await post(url, body, { headers, ...(timeoutMs !== undefined && { timeoutMs }) })) ?? {});
  };
  return { post, fetch };
}
