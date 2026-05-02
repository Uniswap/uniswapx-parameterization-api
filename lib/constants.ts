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

export const WEBHOOK_TIMEOUT_MS = 500;
export const NOTIFICATION_TIMEOUT_MS = 10;

// Default decay duration for V3 Dutch orders, in seconds (wallclock time, not blocks).
export const V3_DEFAULT_DECAY_DURATION_SECS = 30;

// Per-chain block time in seconds.
// Arbitrum block time per public docs; V2 fade math is time-based so this only affects new V3 helpers
export function getBlockTimeSecs(chainId: number): number {
  switch (chainId) {
    case 1: // MAINNET
      return 12;
    case 42161: // ARBITRUM_ONE
      return 0.25;
    case 4217: // TEMPO
      return 0.5;
    default:
      return 12;
  }
}

// Number of blocks for the V3 decay window, derived from wallclock duration / block time.
export function getDecayBlockLength(chainId: number): number {
  return Math.ceil(V3_DEFAULT_DECAY_DURATION_SECS / getBlockTimeSecs(chainId));
}

// Per-chain V3 decay-start block buffer. Existing chains preserve scalar behavior of 4.
const V3_BLOCK_BUFFER_DEFAULT = 4;
const V3_BLOCK_BUFFER_MAP: Record<number, number> = {
  1: 4, // MAINNET
  42161: 4, // ARBITRUM_ONE
  4217: 1, // TEMPO
};

export function getV3BlockBuffer(chainId: number): number {
  return V3_BLOCK_BUFFER_MAP[chainId] ?? V3_BLOCK_BUFFER_DEFAULT;
}

/** @deprecated use getV3BlockBuffer(chainId) */
export const V3_BLOCK_BUFFER = V3_BLOCK_BUFFER_DEFAULT;

export const RPC_HEADERS = {
  'x-uni-service-id': 'x_parameterization_api',
} as const