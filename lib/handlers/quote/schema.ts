import Joi from 'joi';

import { FieldValidator } from '../../util/validator';

export const PostQuoteRequestBodyJoi = Joi.object({
  offerer: FieldValidator.address.required(),
  tokenIn: FieldValidator.address.required(),
  amountIn: FieldValidator.amount.required(),
  tokenOut: FieldValidator.address.required(),
});

export type PostQuoteRequestBody = {
  offerer: string;
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
};

export const PostQuoteResponseJoi = Joi.object({
  requestId: Joi.string().required(),
  tokenIn: Joi.string().required(),
  amountIn: FieldValidator.amount.required(),
  tokenOut: Joi.string().required(),
  amountOut: FieldValidator.amount.required(),
  offerer: FieldValidator.address.required(),
});

export type PostQuoteResponse = {
  requestId: string;
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
  amountOut: string;
  offerer: string;
};
