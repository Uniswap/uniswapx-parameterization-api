import { buildConnector, ProxyAgent } from 'undici';

import { FetchFn, fetchUnderDeadline } from '../util/fetch-http';

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

export interface ProxiedFetchOptions {
  /** TLS options for the connection to an HTTPS market maker, e.g. a private CA in tests. */
  tls?: buildConnector.BuildOptions;
}

/**
 * A fetch that sends every request through the forward proxy at `proxyUrl`, with the same
 * whole-request deadline as `timedFetch`. It is Node's own fetch with undici's ProxyAgent as the
 * dispatcher, so a market maker receives byte-for-byte what a direct call sends: same header
 * names, casing and order, same `User-Agent`. Both HTTPS and plain-HTTP targets go through a
 * CONNECT tunnel, so the proxy passes the bytes through untouched; HTTPS negotiates TLS over the
 * tunnel with the hostname as the server name, exactly as a direct call would.
 *
 * The proxy resolves the hostname and connects, so its address handling is what the call gets:
 * squid tries a multi-address answer one address at a time, bounded by its `connect_timeout`
 * (see squid.conf). A direct call would instead move to the next address after 250 ms. That
 * difference is accepted here rather than worked around in this client, because the backend
 * service reaches the same proxy through Bun's fetch and gets the proxy's behavior regardless;
 * a fallback that only this client had would prove nothing about what the backend will see.
 *
 * One behavior differs from a direct call: when the market maker can't be reached, the proxy
 * answers the tunnel request with an error status, so the failure reads as a proxy tunnel error
 * rather than a socket error such as ECONNREFUSED. It is still a network failure, classified the
 * same way.
 */
export function proxiedFetch(proxyUrl: string, options: ProxiedFetchOptions = {}): FetchFn {
  const dispatcher = new ProxyAgent({ uri: proxyUrl, requestTls: options.tls });
  return (input, init, config) =>
    config?.timeoutMs
      ? fetchUnderDeadline(config.timeoutMs, (signal) => fetch(input, { ...init, signal, dispatcher }))
      : fetch(input, { ...init, dispatcher });
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
  return (input, init, config) =>
    random() * 100 < sharePercent ? proxied(input, init, config) : direct(input, init, config);
}
