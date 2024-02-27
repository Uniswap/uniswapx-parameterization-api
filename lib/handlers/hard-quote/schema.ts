import Joi from 'joi';

import { FieldValidator } from '../../util/validator';

/* Hard quote request from user */
export const HardQuoteRequestBodyJoi = Joi.object({
  requestId: FieldValidator.requestId.required(),
  quoteId: FieldValidator.uuid.optional(),
  encodedInnerOrder: Joi.string().required(),
  innerSig: FieldValidator.rawSignature.required(),
  tokenInChainId: FieldValidator.chainId.required(),
  tokenOutChainId: Joi.number().integer().valid(Joi.ref('tokenInChainId')).required(),
});

export type HardQuoteRequestBody = {
  requestId: string;
  quoteId?: string;
  encodedInnerOrder: string;
  innerSig: string;
  tokenInChainId: number;
  tokenOutChainId: number;
};

export const HardQuoteResponseDataJoi = Joi.object({
  chainId: FieldValidator.chainId.required(),
  requestId: FieldValidator.uuid.required(),
  tokenIn: Joi.string().required(),
  amountIn: FieldValidator.amount.required(),
  tokenOut: Joi.string().required(),
  amountOut: FieldValidator.amount.required(),
  orderHash: FieldValidator.orderHash.required(),
  swapper: FieldValidator.address.optional(),
  filler: FieldValidator.address,
  quoteId: FieldValidator.uuid,
});

export type HardQuoteResponseData = {
  chainId: number;
  requestId: string;
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
  amountOut: string;
  swapper: string;
  orderHash: string,
  filler?: string;
  quoteId?: string;
};
