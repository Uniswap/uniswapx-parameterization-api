import Joi from 'joi';

import { ProtocolVersion } from '../../providers';
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
  numOutputs: Joi.number().integer().min(1).required(),
  protocol: FieldValidator.protocol.default(ProtocolVersion.V1),
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
  numOutputs: number;
  protocol: ProtocolVersion;
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
  quoteId: FieldValidator.uuid,
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
  quoteId?: string;
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
  quoteId: FieldValidator.uuid,
});

export type RfqResponse = {
  chainId: number;
  requestId: string;
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
  amountOut: string;
  quoteId: string;
  filler?: string;
};
