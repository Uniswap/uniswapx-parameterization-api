import Joi from 'joi';

import { FieldValidator } from '../../util/validator';

export const PostQuoteRequestBodyJoi = Joi.object({
  requestId: FieldValidator.requestId.required(),
  tokenInChainId: FieldValidator.chainId.required(),
  tokenOutChainId: Joi.number().integer().valid(Joi.ref('tokenInChainId')).required(),
  swapper: FieldValidator.address.required(),
  tokenIn: FieldValidator.address.required(),
  tokenOut: FieldValidator.address.required(),
  amount: FieldValidator.amount.required(),
  type: FieldValidator.tradeType.required(),
});

export type PostQuoteRequestBody = {
  requestId: string;
  tokenInChainId: number;
  tokenOutChainId: number;
  swapper: string;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  type: string;
};

export const PostQuoteResponseJoi = Joi.object({
  chainId: FieldValidator.chainId.required(),
  requestId: FieldValidator.uuid.required(),
  tokenIn: Joi.string().required(),
  amountIn: FieldValidator.amount.required(),
  tokenOut: Joi.string().required(),
  amountOut: FieldValidator.amount.required(),
  swapper: FieldValidator.address.optional(),
  filler: FieldValidator.address,
});

export type PostQuoteResponse = {
  chainId: number;
  requestId: string;
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
  amountOut: string;
  swapper: string;
  filler?: string;
};

export const URAResponseJoi = Joi.object({
  chainId: FieldValidator.chainId.required(),
  requestId: FieldValidator.uuid.required(),
  tokenIn: Joi.string().required(),
  amountIn: FieldValidator.amount.required(),
  tokenOut: Joi.string().required(),
  amountOut: FieldValidator.amount.required(),
  swapper: FieldValidator.address.required(),
  filler: FieldValidator.address,
  quoteId: FieldValidator.uuid,
});

export const RfqResponseJoi = Joi.object({
  chainId: FieldValidator.chainId.required(),
  requestId: FieldValidator.uuid.required(),
  tokenIn: Joi.string().required(),
  amountIn: FieldValidator.amount.required(),
  tokenOut: Joi.string().required(),
  amountOut: FieldValidator.amount.required(),
  filler: FieldValidator.address.optional(),
});

export type RfqResponse = {
  chainId: number;
  requestId: string;
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
  amountOut: string;
  filler?: string;
};
