import { ProxyAgent, fetch as undiciFetch } from 'undici';

import { FetchFn } from './fetch-webhook-http';

// The egress proxy's address and the share (0-100) of market-maker webhook calls the quote
// Lambdas send through it, both set per stage in bin/app.ts. The backend uniswapx service will
// send all of its webhook calls through this proxy, so routing legacy traffic through it first
// proves it against every real market-maker endpoint before the new service depends on it.
// A missing, invalid or zero share sends every call direct, as before, so rolling back is a
// one-line config change.
export const EGRESS_PROXY_URL_ENV = 'EGRESS_PROXY_URL';
export const EGRESS_PROXY_WEBHOOK_SHARE_ENV = 'EGRESS_PROXY_WEBHOOK_SHARE_PERCENT';

/** A whole-number percentage from 0 to 100, or undefined for anything else. */
export function parseEgressProxyShare(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d{1,3}$/.test(raw)) {
    return undefined;
  }
  const share = Number(raw);
  return share <= 100 ? share : undefined;
}

/**
 * A fetch that sends every request through the forward proxy at `proxyUrl`. Both HTTPS and
 * plain-HTTP targets go through a CONNECT tunnel (undici's default), so the proxy passes the
 * bytes through untouched and a market maker receives exactly what a direct call would send.
 * undici's own fetch is used with its own ProxyAgent, pinned to the undici version Node 22's
 * built-in fetch ships, so the proxied and direct calls run the same HTTP client.
 *
 * One behavior differs from a direct call: when the market maker can't be reached, the proxy
 * answers the tunnel request with an error status, so the failure reads as a proxy tunnel error
 * rather than a socket error such as ECONNREFUSED. It is still a network failure, classified the
 * same way.
 */
export function proxiedFetch(proxyUrl: string): FetchFn {
  const dispatcher = new ProxyAgent(proxyUrl);
  return async (input, init) => {
    const response = await undiciFetch(input, {
      method: init.method,
      headers: headerEntries(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
      signal: init.signal ?? undefined,
      dispatcher,
    });
    // The quoter reads only status, statusText and the text body; a built-in Response carries
    // those unchanged and keeps FetchFn's return type. An empty body becomes null because the
    // Response constructor rejects any body, even '', on a no-body status such as 204.
    const text = await response.text();
    return new Response(text === '' ? null : text, { status: response.status, statusText: response.statusText });
  };
}

/**
 * Sends `sharePercent` percent of calls through `proxied` and the rest through `direct`,
 * choosing per call. 0 and 100 skip the coin flip entirely.
 */
export function splitFetch(
  direct: FetchFn,
  proxied: FetchFn,
  sharePercent: number,
  random: () => number = Math.random
): FetchFn {
  if (sharePercent <= 0) {
    return direct;
  }
  if (sharePercent >= 100) {
    return proxied;
  }
  return (input, init) => (random() * 100 < sharePercent ? proxied(input, init) : direct(input, init));
}

function headerEntries(headers: RequestInit['headers']): [string, string][] {
  return [...new Headers(headers).entries()];
}
