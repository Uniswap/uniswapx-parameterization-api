import { AxiosError, AxiosHeaders, AxiosResponse } from 'axios';

import { WebhookHttp } from './WebhookQuoter';

// Which HTTP client the quote Lambdas use for market-maker webhooks and block notifications, set
// per stage in bin/app.ts. Anything other than 'fetch' (including unset) keeps axios, so rolling
// back is a one-line config change. Order-service calls are unaffected.
export const WEBHOOK_HTTP_CLIENT_ENV = 'WEBHOOK_HTTP_CLIENT';
export enum WebhookHttpClient {
  AXIOS = 'axios',
  FETCH = 'fetch',
}

/** The fetch signature this client needs; injectable so tests can run it without a network. */
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

// The headers axios sends for a JSON-object POST, so market makers see the same request from
// either client. Per-endpoint headers from the rfq config are applied on top, case-insensitively.
// User-Agent is deliberately not copied: it becomes fetch's default instead of `axios/<version>`.
const DEFAULT_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
};

/**
 * A fetch-based stand-in for the axios `post` that WebhookQuoter uses for market-maker webhooks
 * and block notifications. It resolves and rejects exactly as axios does, so the quoter's quote,
 * non-quote, timeout and error classification, and the analytics records built from them, don't
 * change with the client:
 * - 2xx resolves `{ status, data }`, with the body JSON-parsed when it parses and left as text
 *   when it doesn't (an empty body is `''`), matching axios's default response handling.
 * - Any other status rejects an AxiosError `Request failed with status code N` (code
 *   ERR_BAD_REQUEST for 4xx, ERR_BAD_RESPONSE otherwise) carrying the parsed response.
 * - A timeout rejects an AxiosError `timeout of Nms exceeded` with code ECONNABORTED.
 * - A network failure rejects an AxiosError with the underlying message and code.
 *
 * One behavior differs on purpose: the timeout is a wall-clock deadline for the whole request,
 * body included. Axios's timeout restarts on socket activity, so a response that trickles in
 * could outlast it; here it can't.
 */
export function fetchWebhookHttp(fetchFn: FetchFn = fetch): WebhookHttp {
  return {
    post: async (url, body, config) => {
      const timeoutMs = config?.timeout;
      const headers = new Headers(DEFAULT_HEADERS);
      for (const [name, value] of Object.entries(config?.headers ?? {})) {
        if (typeof value === 'string') {
          headers.set(name, value);
        }
      }

      let response: Response;
      let text: string;
      try {
        response = await fetchFn(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        });
        // Read under the same deadline: the signal also aborts a body still arriving.
        text = await response.text();
      } catch (e) {
        throw toAxiosError(e, timeoutMs);
      }

      const data = parseBody(text);
      if (response.status >= 200 && response.status < 300) {
        return { status: response.status, data };
      }
      throw new AxiosError(
        `Request failed with status code ${response.status}`,
        response.status >= 400 && response.status < 500 ? AxiosError.ERR_BAD_REQUEST : AxiosError.ERR_BAD_RESPONSE,
        undefined,
        undefined,
        toAxiosResponse(response.status, response.statusText, data)
      );
    },
  } as WebhookHttp;
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
