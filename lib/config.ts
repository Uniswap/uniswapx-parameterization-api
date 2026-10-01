import { FADES_COUNT_NEVER_FILLED_TERMINAL_AS_FADE_ENV } from './constants';
import {
  HARD_QUOTE_ANALYTICS_EVENT_TYPES,
  QUOTE_ANALYTICS_STREAM_ENV,
  QuoteAnalyticsEventType,
  SOFT_QUOTE_ANALYTICS_EVENT_TYPES,
} from './providers/analytics/quote-analytics';
import { EGRESS_PROXY_URL_ENV, EGRESS_PROXY_WEBHOOK_SHARE_ENV } from './quoters/egress-proxy-fetch';
import { STAGE } from './util/stage';

/**
 * The only place the service reads its environment.
 *
 * Each entrypoint loads its config once, when the quote Lambda builds its container or the breaker
 * cron starts, and hands plain values to what it wires. A missing or malformed required value fails
 * that build with a message naming the variable, instead of surfacing later as a request that
 * quietly misbehaves (a webhook roster read from `rfq-config-undefined-1`, an RPC URL of
 * `undefined/1`). The backend service's `dependencies.ts` reads the same values from its own config
 * at boot, so this is the seam the port replaces.
 */

type Env = NodeJS.ProcessEnv;

/** Internal RPC endpoint: per-chain URLs are `<prefixUrl>/<chainId>`. */
export interface RpcConfig {
  prefixUrl: string;
  // Authenticates requests to the internal provider; absent locally and in unit tests.
  headerSecret?: string;
}

/**
 * The egress proxy and the share of market-maker webhooks sent through it. The share stays raw:
 * the webhook client validates it and falls back to direct (with a warning) when it is invalid,
 * which keeps rollback a one-line config change.
 */
export interface EgressProxyConfig {
  url?: string;
  rawShare?: string;
}

export interface QuoteConfig {
  stage: STAGE;
  rpc: RpcConfig;
  // The webhook-response analytics stream (FirehoseStack).
  webhookResponseStreamArn: string;
  egressProxy: EgressProxyConfig;
  // Direct-write stream names, for the record types whose variable is set.
  quoteAnalyticsStreams: Partial<Record<QuoteAnalyticsEventType, string>>;
}

export interface HardQuoteConfig extends QuoteConfig {
  orderServiceUrl: string;
  cosigner: { kmsKeyId: string; region: string };
}

export interface CircuitBreakerConfig {
  stage: STAGE;
  orderServiceUrl: string;
  // Policy flag: score cancelled / insufficient-funds / error orders as fades. Off by default.
  countNeverFilledTerminalAsFade: boolean;
}

const STAGES: readonly string[] = Object.values(STAGE);
const FIREHOSE_STREAM_ARN = /^arn:aws:firehose:[a-z0-9-]+:\d{12}:deliverystream\/[a-zA-Z0-9_.-]+$/;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function httpUrl(env: Env, name: string): string {
  const value = required(env, name);
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error(`${name} must be an http(s) URL`);
  }
  return value;
}

function stage(env: Env): STAGE {
  const value = required(env, 'stage');
  const known = Object.values(STAGE).find((s) => s === value);
  if (known === undefined) {
    throw new Error(`stage must be one of ${STAGES.join(', ')}, got ${value}`);
  }
  return known;
}

function booleanFlag(env: Env, name: string): boolean {
  const value = optional(env, name);
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be 'true' or 'false', got ${value}`);
}

/** Config shared by both quote Lambdas. */
export function loadQuoteConfig(env: Env = process.env): QuoteConfig {
  const webhookResponseStreamArn = required(env, 'ANALYTICS_STREAM_ARN');
  if (!FIREHOSE_STREAM_ARN.test(webhookResponseStreamArn)) {
    throw new Error(`ANALYTICS_STREAM_ARN is not a Firehose delivery stream ARN: ${webhookResponseStreamArn}`);
  }
  const quoteAnalyticsStreams: Partial<Record<QuoteAnalyticsEventType, string>> = {};
  for (const eventType of [...SOFT_QUOTE_ANALYTICS_EVENT_TYPES, ...HARD_QUOTE_ANALYTICS_EVENT_TYPES]) {
    const stream = optional(env, QUOTE_ANALYTICS_STREAM_ENV[eventType]);
    if (stream !== undefined) quoteAnalyticsStreams[eventType] = stream;
  }
  return {
    stage: stage(env),
    rpc: { prefixUrl: httpUrl(env, 'RPC_PREFIX_URL'), headerSecret: optional(env, 'RPC_HEADER_SECRET') },
    webhookResponseStreamArn,
    egressProxy: { url: optional(env, EGRESS_PROXY_URL_ENV), rawShare: env[EGRESS_PROXY_WEBHOOK_SHARE_ENV] },
    quoteAnalyticsStreams,
  };
}

/** Config for the hard-quote Lambda: the shared quote config plus the order service and the cosigner key. */
export function loadHardQuoteConfig(env: Env = process.env): HardQuoteConfig {
  return {
    ...loadQuoteConfig(env),
    orderServiceUrl: httpUrl(env, 'ORDER_SERVICE_URL'),
    cosigner: { kmsKeyId: required(env, 'KMS_KEY_ID'), region: required(env, 'REGION') },
  };
}

/** Config for the fade circuit-breaker cron. */
export function loadCircuitBreakerConfig(env: Env = process.env): CircuitBreakerConfig {
  return {
    stage: stage(env),
    orderServiceUrl: httpUrl(env, 'ORDER_SERVICE_URL'),
    countNeverFilledTerminalAsFade: booleanFlag(env, FADES_COUNT_NEVER_FILLED_TERMINAL_AS_FADE_ENV),
  };
}

/** True under Jest, which sets NODE_ENV=test; the API handler silences its request logs then. */
export function isTestRun(env: Env = process.env): boolean {
  return env.NODE_ENV === 'test';
}
