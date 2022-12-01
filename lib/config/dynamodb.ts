export enum DYNAMODB_TYPE {
  STRING = 'string',
  NUMBER = 'number',
  BINARY = 'binary',
  BOOLEAN = 'boolean',
  LIST = 'list',
}

export enum QUOTES_TABLE_KEY {
  REQUEST_ID = 'requestId',
  TYPE = 'type',
  CREATED_AT = 'createdAt',
  TOKEN_IN = 'tokenIn',
  TOKEN_OUT = 'tokenOut',
  AMOUNT_IN = 'amountIn',
  AMOUNT_OUT = 'amountOut',
  DEADLINE = 'deadline',
  OFFERER = 'offerer',
  FILLER = 'filler',
}

export enum QUOTES_TABLE_INDEX {
  OFFERER_TYPE = 'offerer-type',
  FILLER = 'filler',
}
