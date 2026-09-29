/**
 * The outbound fetch every caller takes: the monorepo's `ctx.fetch` shape, with the timeout as a
 * third argument, so the port can hand in `ctx.fetch` unchanged.
 */
export type FetchFn = (input: string, init?: RequestInit, config?: { timeoutMs?: number }) => Promise<Response>;

/**
 * The global fetch with `timeoutMs` as a wall-clock deadline over the whole request. The abort
 * also cancels a body still arriving, so a server that trickles its reply can't outlast it.
 * (The monorepo's `ctx.fetch` timeout bounds response headers only; the port should keep a
 * whole-request signal alongside it.)
 */
export const timedFetch: FetchFn = (input, init, config) =>
  fetch(input, config?.timeoutMs ? { ...init, signal: AbortSignal.timeout(config.timeoutMs) } : init);

/**
 * A request that didn't produce a 2xx: the server answered with another status (`status` and the
 * parsed body in `data`), the deadline passed, or the connection failed. Only `status` failures
 * mean the server saw and refused the request.
 */
export class HttpError extends Error {
  override readonly name = 'HttpError';

  constructor(
    message: string,
    readonly kind: 'status' | 'timeout' | 'network',
    readonly status?: number,
    readonly data?: unknown
  ) {
    super(message);
  }
}

export interface JsonRequest {
  method: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Sends a request with a JSON body (when there is one) and reads the reply, JSON-parsed when it
 * parses and text when it doesn't (`''` when empty). A 2xx resolves; anything else throws an
 * HttpError. The messages are the ones the analytics records and logs have always carried.
 */
export async function fetchJson<T>(
  fetchFn: FetchFn,
  url: string,
  { method, body, headers, timeoutMs }: JsonRequest
): Promise<{ status: number; data: T }> {
  // Per-endpoint headers replace a default of the same name, whatever its case.
  const requestHeaders = new Headers({
    Accept: 'application/json, text/plain, */*',
    ...(body !== undefined && { 'Content-Type': 'application/json' }),
  });
  for (const [name, value] of Object.entries(headers ?? {})) {
    requestHeaders.set(name, value);
  }

  let response: Response;
  let text: string;
  try {
    response = await fetchFn(
      url,
      { method, headers: requestHeaders, ...(body !== undefined && { body: JSON.stringify(body) }) },
      { timeoutMs }
    );
    // Read under the same deadline: the abort also cancels a body still arriving.
    text = await response.text();
  } catch (e) {
    throw isTimeout(e)
      ? new HttpError(timeoutMs ? `timeout of ${timeoutMs}ms exceeded` : 'timeout exceeded', 'timeout')
      : new HttpError(networkMessage(e), 'network');
  }

  const data = parseBody(text);
  if (!response.ok) {
    throw new HttpError(`Request failed with status code ${response.status}`, 'status', response.status, data);
  }
  // The body's type is the caller's claim about the server; it is not validated here.
  return { status: response.status, data: data as T };
}

function parseBody(text: string): unknown {
  if (text === '') {
    return '';
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// By name, not instanceof: the abort is a DOMException, which isn't an Error subclass in every
// runtime, and the monorepo's ErrTimeout may come from another bundle's copy of the class.
function isTimeout(e: unknown): boolean {
  const name = field(e, 'name');
  return name === 'TimeoutError' || name === 'AbortError' || name === 'ErrTimeout';
}

// fetch reports a network failure as `TypeError: fetch failed` with the socket error as the cause;
// the cause's message (e.g. `connect ECONNREFUSED 10.0.0.1:443`) is the useful part.
function networkMessage(e: unknown): string {
  const cause = typeof e === 'object' && e !== null && 'cause' in e && e.cause ? e.cause : e;
  return field(cause, 'message') ?? String(cause);
}

// Duck-typed: errors thrown by Node's own fetch fail `instanceof Error` under jest's realm.
function field(e: unknown, name: 'name' | 'message'): string | undefined {
  if (typeof e !== 'object' || e === null || !(name in e)) {
    return undefined;
  }
  const value = (e as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}
