import axios, { AxiosError, AxiosHeaders, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';

// Which HTTP client a Lambda uses for its outbound calls, set per stage in bin/app.ts, one flag
// per call site. Anything other than 'fetch' (including unset) keeps axios, so rolling back is a
// one-line config change.
export enum HttpClient {
  AXIOS = 'axios',
  FETCH = 'fetch',
}

/** Market-maker webhooks and block notifications, on the two quote Lambdas. */
export const WEBHOOK_HTTP_CLIENT_ENV = 'WEBHOOK_HTTP_CLIENT';
/** Order-service calls: the hard-quote order post and its reconciliation, and the fade cron's status reads. */
export const ORDER_SERVICE_HTTP_CLIENT_ENV = 'ORDER_SERVICE_HTTP_CLIENT';

/** The fetch signature this client needs; injectable so tests can run it without a network. */
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** The axios subset the fetch client stands in for. */
export type FetchHttp = Pick<AxiosInstance, 'get' | 'post'>;

// The headers axios sends, so servers see the same request from either client. Per-call headers
// are applied on top, case-insensitively. User-Agent is deliberately not copied: it becomes
// fetch's default instead of `axios/<version>`. Axios only sends Content-Type with a body.
const ACCEPT = 'application/json, text/plain, */*';
const JSON_CONTENT_TYPE = 'application/json';

/**
 * A fetch-based stand-in for the axios `get` and `post` this service uses. It resolves and
 * rejects exactly as axios does, so callers' classification of the outcome (and anything built
 * from it, like analytics records) doesn't change with the client:
 * - 2xx resolves `{ status, data }`, with the body JSON-parsed when it parses and left as text
 *   when it doesn't (an empty body is `''`), matching axios's default response handling.
 * - Any other status rejects an AxiosError `Request failed with status code N` (code
 *   ERR_BAD_REQUEST for 4xx, ERR_BAD_RESPONSE otherwise) carrying the parsed response.
 * - A timeout rejects an AxiosError `timeout of Nms exceeded` with code ECONNABORTED.
 * - A network failure rejects an AxiosError with the underlying message and code.
 * GET `params` are serialized by axios itself, so the URL is byte-for-byte what axios requests.
 *
 * One behavior differs on purpose: the timeout is a wall-clock deadline for the whole request,
 * body included. Axios's timeout restarts on socket activity, so a response that trickles in
 * could outlast it; here it can't.
 */
export function fetchHttp(fetchFn: FetchFn = fetch): FetchHttp {
  return {
    get: (url: string, config?: AxiosRequestConfig) =>
      request(fetchFn, 'GET', config?.params ? axios.getUri({ url, params: config.params }) : url, undefined, config),
    post: (url: string, body?: unknown, config?: AxiosRequestConfig) => request(fetchFn, 'POST', url, body, config),
  } as FetchHttp;
}

async function request(
  fetchFn: FetchFn,
  method: 'GET' | 'POST',
  url: string,
  body: unknown,
  config: AxiosRequestConfig | undefined
): Promise<AxiosResponse> {
  const timeoutMs = config?.timeout;
  const headers = new Headers({ Accept: ACCEPT, ...(body !== undefined && { 'Content-Type': JSON_CONTENT_TYPE }) });
  for (const [name, value] of Object.entries(config?.headers ?? {})) {
    if (typeof value === 'string') {
      headers.set(name, value);
    }
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
    throw toAxiosError(e, timeoutMs);
  }

  const data = parseBody(text);
  const axiosResponse = toAxiosResponse(response.status, response.statusText, data);
  if (response.status >= 200 && response.status < 300) {
    return axiosResponse;
  }
  throw new AxiosError(
    `Request failed with status code ${response.status}`,
    response.status >= 400 && response.status < 500 ? AxiosError.ERR_BAD_REQUEST : AxiosError.ERR_BAD_RESPONSE,
    undefined,
    undefined,
    axiosResponse
  );
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

function toAxiosResponse(status: number, statusText: string, data: unknown): AxiosResponse {
  return { status, statusText, data, headers: {}, config: { headers: new AxiosHeaders() } };
}

function toAxiosError(e: unknown, timeoutMs: number | undefined): AxiosError {
  // Checked by name, not instanceof: the abort is a DOMException, which isn't an Error subclass
  // in every runtime.
  const name = errorField(e, 'name');
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new AxiosError(
      timeoutMs ? `timeout of ${timeoutMs}ms exceeded` : 'timeout exceeded',
      AxiosError.ECONNABORTED
    );
  }
  // fetch reports network failures as `TypeError: fetch failed` with the socket error as the cause.
  // Wrapped with AxiosError.from, as axios does, so the error keeps the socket error's name, message
  // and code (e.g. `Error: connect ECONNREFUSED ...`).
  const cause = typeof e === 'object' && e !== null && 'cause' in e && e.cause ? e.cause : e;
  return AxiosError.from(cause, errorField(cause, 'code'));
}

function errorField(e: unknown, field: 'name' | 'message' | 'code'): string | undefined {
  if (typeof e !== 'object' || e === null || !(field in e)) {
    return undefined;
  }
  const value = (e as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}
