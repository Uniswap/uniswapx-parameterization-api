import { BigNumber } from 'ethers';
import Joi from 'joi';

import { RequestFieldValidator, ResponseFieldValidator } from '../../util/validator';

export const PostQuoteRequestBodyJoi = Joi.object({
  offerer: RequestFieldValidator.address.required(),
  tokenIn: RequestFieldValidator.address.required(),
  amountIn: RequestFieldValidator.amount.required(),
  tokenOut: RequestFieldValidator.address.required(),
});

export type PostQuoteRequestBody = {
  offerer: string;
  tokenIn: string;
  amountIn: BigNumber;
  tokenOut: string;
};

export const PostQuoteResponseJoi = Joi.object({
  requestId: Joi.string().required(),
  tokenIn: Joi.string().required(),
  amountIn: ResponseFieldValidator.amount.required(),
  tokenOut: Joi.string().required(),
  amountOut: ResponseFieldValidator.amount.required(),
});

export type PostQuoteResponse = {
  requestId: string;
  tokenIn: string;
  amountIn: BigNumber;
  tokenOut: string;
  amountOut: BigNumber;
};
