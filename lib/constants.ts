import { secondsToBlocks } from '@uniswap/sdk-core';
import { ChainId } from './util/chains';

export const WEBHOOK_CONFIG_BUCKET = 'rfq-config';
export const FADE_RATE_BUCKET = 'fade-rate-config';
export const PRODUCTION_S3_KEY = 'production.json';
export const BETA_S3_KEY = 'beta.json';

export const DYNAMO_TABLE_NAME = {
  FILLER_ADDRESS: 'FillerAddress',
  // Circuit-breaker state table for the rate-based breaker. State is derived (recomputed each
  // cron run from Redshift). The name keeps its V2 suffix because it is the live table name.
  FILLER_CB_TIMESTAMPS_V2: 'FillerCBTimestampsV2',
  // GPA's own record of every RFQ-won order it posts (hard-quote path), so the fade breaker
  // can eventually be computed from first-hand data instead of the Redshift analytics
  // pipeline. Derived and rebuildable; rows expire POSTED_ORDER_TTL_SECS after their deadline.
  POSTED_ORDERS: 'PostedOrders',
};

export const POSTED_ORDERS_INDEX = {
  // Sparse: only rows whose outcome is still pending carry the `pending` key attribute, so
  // "every order past its deadline with no recorded outcome" is one range query on one key.
  PENDING_DEADLINE: 'pending-deadline-index',
  // "A filler's orders completed (deadline passed) in the last 24h" — keyed by the filler
  // identity the breaker scores by (the webhook endpoint), not the onchain address.
  FILLER_DEADLINE: 'filler-deadline-index',
};

// Rows are only useful until the breaker has scored them; 48h past the deadline leaves a
// full 24h scoring window plus a day of slack for a stalled cron.
export const POSTED_ORDER_TTL_SECS = 48 * 60 * 60;

export const DYNAMO_TABLE_KEY = {
  BLOCK_UNTIL_TIMESTAMP: 'blockUntilTimestamp',
  LAST_EXAMINED_TIMESTAMP: 'lastExaminedTimestamp',
  FADE_WINDOW_START: 'fadeWindowStart',
  CONSECUTIVE_BLOCKS: 'consecutiveBlocks',
  CONSECUTIVE_CLEAN_RUNS: 'consecutiveCleanRuns',
};

export const POST_ORDER_ERROR_REASON = {
  INSUFFICIENT_FUNDS: 'Onchain validation failed: InsufficientFunds',
};

// Per-chain webhook (RFQ) timeout. 500 ms across all chains — the previous
// 250 ms default on non-mainnet chains was too tight for MMs to respond,
// causing quote requests to time out and return no quotes.
const WEBHOOK_TIMEOUT_MS_DEFAULT = 500;
const WEBHOOK_TIMEOUT_MS_MAINNET = 500;

export function getWebhookTimeoutMs(chainId: number): number {
  return chainId === ChainId.MAINNET ? WEBHOOK_TIMEOUT_MS_MAINNET : WEBHOOK_TIMEOUT_MS_DEFAULT;
}

export const NOTIFICATION_TIMEOUT_MS = 10;

// Wallclock target between order receipt and the decay window opening.
// Cosigners need a small lead so the swapper-signed `decayStartBlock` is
// reliably in the future when the order is broadcast.
export const V3_DECAY_START_BUFFER_SECS = 5;

// Number of blocks for the V3 decay-start buffer, derived from wallclock
// duration / per-chain block time (sourced from @uniswap/sdk-core).
export function getV3BlockBuffer(chainId: number): number {
  return secondsToBlocks(V3_DECAY_START_BUFFER_SECS, chainId);
}

export const RPC_HEADERS: { [key: string]: string } = {
  'x-uni-service-id': 'x_parameterization_api',
  // Authenticate RPC requests against internal providers. The value is provided
  // via the RPC_HEADER_SECRET env var (sourced from Secrets Manager); omitted
  // when unset (e.g. local dev / unit tests).
  ...(process.env.RPC_HEADER_SECRET ? { 'x-internal-service-secret': process.env.RPC_HEADER_SECRET } : {}),
};
