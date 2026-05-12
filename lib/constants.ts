export const COMPLIANCE_CONFIG_BUCKET = 'compliance-config';
export const WEBHOOK_CONFIG_BUCKET = 'rfq-config';
export const SYNTH_SWITCH_BUCKET = 'synth-config';
export const FADE_RATE_BUCKET = 'fade-rate-config';
export const INTEGRATION_S3_KEY = 'integration.json';
export const PRODUCTION_S3_KEY = 'production.json';
export const BETA_S3_KEY = 'beta.json';
export const FADE_RATE_S3_KEY = 'fade-rate.json';
export const PROD_COMPLIANCE_S3_KEY = 'production.json';
export const BETA_COMPLIANCE_S3_KEY = 'beta.json';

export const DYNAMO_TABLE_NAME = {
  FADES: 'Fades',
  SYNTHETIC_SWITCH_TABLE: 'SyntheticSwitchTable',
  FILLER_ADDRESS: 'FillerAddress',
  FILLER_CB_TIMESTAMPS: 'FillerCBTimestamps',
};

export const DYNAMO_TABLE_KEY = {
  FILLER: 'filler',
  TOKEN_IN: 'tokenIn',
  TOKEN_IN_CHAIN_ID: 'tokenInChainId',
  TOKEN_OUT: 'tokenOut',
  TOKEN_OUT_CHAIN_ID: 'tokenOutChainId',
  TRADE_TYPE: 'type',
  LOWER: 'lower',
  ENABLED: 'enabled',
  BLOCK_UNTIL_TIMESTAMP: 'blockUntilTimestamp',
  LAST_POST_TIMESTAMP: 'lastPostTimestamp',
  FADED: 'faded',
  CONSECUTIVE_BLOCKS: 'consecutiveBlocks',
};

export const POST_ORDER_ERROR_REASON = {
  INSUFFICIENT_FUNDS: 'Onchain validation failed: InsufficientFunds',
};

// Per-chain webhook (RFQ) timeout. Default 250 ms so a slow MM can't drag the
// whole quote-aggregation step on fast chains; Mainnet 500 ms to accommodate
// higher MM latency.
const WEBHOOK_TIMEOUT_MS_DEFAULT = 250;
const WEBHOOK_TIMEOUT_MS_MAINNET = 500;

export function getWebhookTimeoutMs(chainId: number): number {
  return chainId === 1 ? WEBHOOK_TIMEOUT_MS_MAINNET : WEBHOOK_TIMEOUT_MS_DEFAULT;
}

export const NOTIFICATION_TIMEOUT_MS = 10;

// Default decay duration for V3 Dutch orders, in seconds (wallclock time, not blocks).
export const V3_DEFAULT_DECAY_DURATION_SECS = 30;

// Per-chain block time in seconds. Used by V3 helpers (decay block length).
// V2 fade math is time-based, so block time only matters for V3.
export function getBlockTimeSecs(chainId: number): number {
  switch (chainId) {
    case 1: // MAINNET
      return 12;
    case 10: // OPTIMISM
      return 2;
    case 56: // BNB
      return 3;
    case 130: // UNICHAIN
      return 1;
    case 137: // POLYGON
      return 2;
    case 143: // MONAD
      return 1;
    case 196: // XLAYER
      return 3;
    case 480: // WORLDCHAIN
      return 2;
    case 1868: // SONEIUM
      return 2;
    case 4217: // TEMPO
      return 0.5;
    case 7777777: // ZORA
      return 2;
    case 8453: // BASE
      return 2;
    case 42161: // ARBITRUM_ONE
      return 0.25;
    case 42220: // CELO
      return 5;
    case 43114: // AVALANCHE
      return 2;
    case 81457: // BLAST
      return 2;
    default:
      return 12;
  }
}

// Number of blocks for the V3 decay window, derived from wallclock duration / block time.
export function getDecayBlockLength(chainId: number): number {
  return Math.ceil(V3_DEFAULT_DECAY_DURATION_SECS / getBlockTimeSecs(chainId));
}

// Wallclock target between order receipt and the decay window opening.
// Cosigners need a small lead so the swapper-signed `decayStartBlock` is
// reliably in the future when the order is broadcast.
export const V3_DECAY_START_BUFFER_SECS = 2;

// Number of blocks for the V3 decay-start buffer, derived from wallclock
// duration / block time.
export function getV3BlockBuffer(chainId: number): number {
  return Math.ceil(V3_DECAY_START_BUFFER_SECS / getBlockTimeSecs(chainId));
}

export const RPC_HEADERS = {
  'x-uni-service-id': 'x_parameterization_api',
} as const