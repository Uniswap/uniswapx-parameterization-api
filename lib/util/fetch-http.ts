/** Per-request options: a whole-request deadline, extra headers, and GET query params. */
export interface HttpRequestConfig {
  timeout?: number;
  headers?: Record<string, string>;
  params?: Record<string, string | number | undefined>;
}

/** A 2xx response: the status, and the body JSON-parsed when it parses, text when it doesn't. */
export interface HttpResponse<T = unknown> {
  status: number;
  data: T;
}

/** The HTTP client every outbound call goes through; tests inject fakes of it. */
export interface HttpClient {
  get<T = unknown>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
  post<T = unknown>(url: string, body?: unknown, config?: HttpRequestConfig): Promise<HttpResponse<T>>;
}

/**
 * Every failure the client reports. `response` is set only when the server answered with a
 * non-2xx status; timeouts and network failures have none, which is how callers tell "the server
 * said no" from "we don't know what happened". Codes and messages are the ones axios used, which
 * the analytics records, logs and dashboards were built on.
 */
export class HttpError extends Error {
  static readonly TIMEOUT = 'ECONNABORTED';
  static readonly BAD_REQUEST = 'ERR_BAD_REQUEST';
  static readonly BAD_RESPONSE = 'ERR_BAD_RESPONSE';

  override readonly name = 'HttpError';

  constructor(message: string, readonly code?: string, readonly response?: HttpResponse) {
    super(message);
  }
}

/** The fetch signature this client needs; injectable so tests can run it without a network. */
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

const ACCEPT = 'application/json, text/plain, */*';
const JSON_CONTENT_TYPE = 'application/json';

/**
 * The HTTP client for every outbound call (market-maker webhooks, block notifications, the order
 * service):
 * - 2xx resolves `{ status, data }`, with the body JSON-parsed when it parses and left as text
 *   when it doesn't (an empty body is `''`).
 * - Any other status rejects an HttpError `Request failed with status code N` (code
 *   ERR_BAD_REQUEST for 4xx, ERR_BAD_RESPONSE otherwise) carrying the parsed response.
 * - A timeout rejects an HttpError `timeout of Nms exceeded` with code ECONNABORTED.
 * - A network failure rejects an HttpError with the socket error's message and code.
 * The timeout is a wall-clock deadline for the whole request, body included.
 */
export function fetchHttp(fetchFn: FetchFn = fetch): HttpClient {
  return {
    get: <T>(url: string, config?: HttpRequestConfig) =>
      request<T>(fetchFn, 'GET', withParams(url, config?.params), undefined, config),
    post: <T>(url: string, body?: unknown, config?: HttpRequestConfig) =>
      request<T>(fetchFn, 'POST', url, body, config),
  };
}

async function request<T>(
  fetchFn: FetchFn,
  method: 'GET' | 'POST',
  url: string,
  body: unknown,
  config: HttpRequestConfig | undefined
): Promise<HttpResponse<T>> {
  const timeoutMs = config?.timeout;
  const headers = new Headers({ Accept: ACCEPT, ...(body !== undefined && { 'Content-Type': JSON_CONTENT_TYPE }) });
  for (const [name, value] of Object.entries(config?.headers ?? {})) {
    headers.set(name, value);
  }

  let response: Response;
  let text: string;
  try {
    response = await fetchFn(url, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    // Read under the same deadline: the signal also aborts a body still arriving.
    text = await response.text();
  } catch (e) {
    throw toHttpError(e, timeoutMs);
  }

  // The body's type is the caller's claim about the server; it is not validated here.
  const parsed = { status: response.status, data: parseBody(text) as T };
  if (response.status >= 200 && response.status < 300) {
    return parsed;
  }
  throw new HttpError(
    `Request failed with status code ${response.status}`,
    response.status >= 400 && response.status < 500 ? HttpError.BAD_REQUEST : HttpError.BAD_RESPONSE,
    parsed
  );
}

// Query values are encoded the way axios encoded them (`:`, `$` and `,` literal, space as `+`),
// so the servers keep seeing the URLs they always have; e.g. the order service's comma-joined
// `orderHashes`. Undefined values are dropped.
function withParams(url: string, params: HttpRequestConfig['params']): string {
  const query = Object.entries(params ?? {})
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeQueryPart(key)}=${encodeQueryPart(String(value))}`)
    .join('&');
  if (!query) {
    return url;
  }
  const base = url.split('#')[0];
  return `${base}${base.includes('?') ? '&' : '?'}${query}`;
}

function encodeQueryPart(value: string): string {
  return encodeURIComponent(value)
    .replace(/%3A/gi, ':')
    .replace(/%24/g, '$')
    .replace(/%2C/gi, ',')
    .replace(/%20/g, '+');
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

function toHttpError(e: unknown, timeoutMs: number | undefined): HttpError {
  // Checked by name, not instanceof: the abort is a DOMException, which isn't an Error subclass
  // in every runtime.
  const name = errorField(e, 'name');
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new HttpError(timeoutMs ? `timeout of ${timeoutMs}ms exceeded` : 'timeout exceeded', HttpError.TIMEOUT);
  }
  // fetch reports network failures as `TypeError: fetch failed` with the socket error as the
  // cause; its message and code (e.g. `connect ECONNREFUSED ...`, ECONNREFUSED) are the useful part.
  const cause = typeof e === 'object' && e !== null && 'cause' in e && e.cause ? e.cause : e;
  return new HttpError(errorField(cause, 'message') ?? String(cause), errorField(cause, 'code'));
}

function errorField(e: unknown, field: 'name' | 'message' | 'code'): string | undefined {
  if (typeof e !== 'object' || e === null || !(field in e)) {
    return undefined;
  }
  const value = (e as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}
