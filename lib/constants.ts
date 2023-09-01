export const WEBHOOK_CONFIG_BUCKET = 'rfq-config';
export const SYNTH_SWITCH_BUCKET = 'synth-config-prod';
export const INTEGRATION_S3_KEY = 'integration.json';
export const PRODUCTION_S3_KEY = 'production.json';

export const DYNAMO_TABLE_NAME = {
  FADES: 'Fades',
  SYNTHETIC_SWITCH_TABLE: 'SyntheticSwitchTable',
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
};
