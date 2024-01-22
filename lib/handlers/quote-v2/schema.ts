import Joi from 'joi';

import { FieldValidator } from '../../util/validator';

/* request body to quote endpoint */
export const IndicativePostQuoteRequestBodyJoi = Joi.object({
  requestId: FieldValidator.requestId.required(),
  tokenInChainId: FieldValidator.chainId.required(),
  tokenOutChainId: Joi.number().integer().valid(Joi.ref('tokenInChainId')).required(),
  swapper: FieldValidator.address.required(),
  tokenIn: FieldValidator.address.required(),
  tokenOut: FieldValidator.address.required(),
  amount: FieldValidator.amount.required(),
  type: FieldValidator.tradeType.required(),
  cosigner: FieldValidator.address.required(),

  numOutputs: Joi.number().integer().min(1).required(),
});

export type IndicativePostQuoteRequestBody = {
  requestId: string;
  tokenInChainId: number;
  tokenOutChainId: number;
  swapper: string;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  type: string;
  cosigner: string;
  numOutputs: number;
};

/* indicative quote response from filler */
export const IndicativePostQuoteResponseJoi = Joi.object({
  tokenInChainId: FieldValidator.chainId.required(),
  tokenOutChainId: FieldValidator.chainId.required(),
  requestId: FieldValidator.uuid.required(),
  tokenIn: Joi.string().required(),
  amountIn: FieldValidator.amount.required(),
  tokenOut: Joi.string().required(),
  amountOut: FieldValidator.amount.required(),
  swapper: FieldValidator.address.optional(),
  cosigner: FieldValidator.address.required(),
  quoteId: FieldValidator.uuid.required(),
});

export type IndicativePostQuoteResponse = {
  tokenInChainId: number;
  tokenOutChainId: number;
  requestId: string;
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
  amountOut: string;
  swapper: string;
  cosigner: string;
  quoteId: string;
};

/* response back to URA */
export const IndicativeURAResponseJoi = Joi.object({
  tokenInChainId: FieldValidator.chainId.required(),
  tokenOutChainId: FieldValidator.chainId.required(),
  requestId: FieldValidator.uuid.required(),
  tokenIn: Joi.string().required(),
  amountIn: FieldValidator.amount.required(),
  tokenOut: Joi.string().required(),
  amountOut: FieldValidator.amount.required(),
  swapper: FieldValidator.address.required(),
  cosigner: FieldValidator.address.required(),
  quoteId: FieldValidator.uuid.required(),
});
