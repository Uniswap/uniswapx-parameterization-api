import { BigNumber } from 'ethers';
import Joi from 'joi';

import { validateAddress, validateAmount, validateAmountResponse } from '../../util/validators';

export const PostQuoteRequestBodyJoi = Joi.object({
  tokenIn: Joi.string().custom(validateAddress, 'Invalid address').required(),
  amountIn: Joi.string().custom(validateAmount, 'Invalid amount').required(),
  tokenOut: Joi.string().custom(validateAddress, 'Invalid address').required(),
});

export type PostQuoteRequestBody = {
  tokenIn: string;
  amountIn: BigNumber;
  tokenOut: string;
};

export const PostQuoteResponseJoi = Joi.object({
  requestId: Joi.string().required(),
  tokenIn: Joi.string().required(),
  amountIn: Joi.custom(validateAmountResponse, 'Invalid amount').required(),
  tokenOut: Joi.string().required(),
  amountOut: Joi.custom(validateAmountResponse, 'Invalid amount').required(),
});

export type PostQuoteResponse = {
  requestId: string;
  tokenIn: string;
  amountIn: BigNumber;
  tokenOut: string;
  amountOut: BigNumber;
};
