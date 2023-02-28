import Joi from 'joi';

import { FieldValidator } from '../../util/validator';

export const PostQuoteRequestBodyJoi = Joi.object({
  requestId: FieldValidator.requestId.required(),
  tokenInChainId: FieldValidator.chainId.required(),
  tokenOutChainId: FieldValidator.chainId.required(),
  offerer: FieldValidator.address.required(),
  tokenIn: FieldValidator.address.required(),
  tokenOut: FieldValidator.address.required(),
  amount: FieldValidator.amount.required(),
  type: FieldValidator.tradeType.required(),
});

export type PostQuoteRequestBody = {
  requestId: string;
  tokenInChainId: number;
  tokenOutChainId: number;
  offerer: string;
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
  offerer: FieldValidator.address.required(),
  filler: FieldValidator.address,
});

export type PostQuoteResponse = {
  chainId: number;
  requestId: string;
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
  amountOut: string;
  offerer: string;
  filler?: string;
};
