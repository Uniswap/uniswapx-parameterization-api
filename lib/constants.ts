import { secondsToBlocks } from '@uniswap/sdk-core';
import { ChainId } from './util/chains';

export const COMPLIANCE_CONFIG_BUCKET = 'compliance-config';
export const WEBHOOK_CONFIG_BUCKET = 'rfq-config';
export const SYNTH_SWITCH_BUCKET = 'synth-config';
export const FADE_RATE_BUCKET = 'fade-rate-config';
export const PRODUCTION_S3_KEY = 'production.json';
export const BETA_S3_KEY = 'beta.json';
export const PROD_COMPLIANCE_S3_KEY = 'production.json';
export const BETA_COMPLIANCE_S3_KEY = 'beta.json';

export const DYNAMO_TABLE_NAME = {
  SYNTHETIC_SWITCH_TABLE: 'SyntheticSwitchTable',
  FILLER_ADDRESS: 'FillerAddress',
  FILLER_CB_TIMESTAMPS: 'FillerCBTimestamps',
  // V2 circuit-breaker state table, separate from FILLER_CB_TIMESTAMPS so the rate-based
  // breaker's state is isolated for independent rollout/rollback. State is derived
  // (recomputed each cron run from Redshift), so it starts empty.
  FILLER_CB_TIMESTAMPS_V2: 'FillerCBTimestampsV2',
};

export const DYNAMO_TABLE_KEY = {
  TOKEN_IN: 'tokenIn',
  TOKEN_IN_CHAIN_ID: 'tokenInChainId',
  TOKEN_OUT: 'tokenOut',
  TOKEN_OUT_CHAIN_ID: 'tokenOutChainId',
  TRADE_TYPE: 'type',
  LOWER: 'lower',
  ENABLED: 'enabled',
  BLOCK_UNTIL_TIMESTAMP: 'blockUntilTimestamp',
  LAST_EXAMINED_TIMESTAMP: 'lastExaminedTimestamp',
  FADE_WINDOW_START: 'fadeWindowStart',
  FADED: 'faded',
  CONSECUTIVE_BLOCKS: 'consecutiveBlocks',
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
