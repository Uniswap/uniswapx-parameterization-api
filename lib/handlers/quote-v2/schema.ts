import Joi from 'joi';
import { FieldValidator } from '../../util/validator';

export * from './hard/schema';
export * from './indicative/schema';

/* v2 rfq request to filler */
export const V2RfqRequestJoi = Joi.object({
  tokenInChainId: FieldValidator.chainId.required(),
  tokenOutChainId: FieldValidator.chainId.required(),
  requestId: FieldValidator.uuid.required(),
  tokenIn: Joi.string().required(),
  amountIn: FieldValidator.amount.required(),
  tokenOut: Joi.string().required(),
  amountOut: FieldValidator.amount.required(),
  quoteId: FieldValidator.uuid.required(),
  numOutputs: Joi.number().min(1).required(),
});

export type V2RfqRequest = {
  tokenInChainId: number;
  tokenOutChainId: number;
  requestId: string;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  type: string;
  quoteId: string;
  numOutputs: number;
};

/* v2 rfq response from filler */
export const V2RfqResponseJoi = Joi.object({
  tokenInChainId: FieldValidator.chainId.required(),
  tokenOutCHainId: FieldValidator.chainId.required(),
  requestId: FieldValidator.uuid.required(),
  tokenIn: Joi.string().required(),
  amountIn: FieldValidator.amount.required(),
  tokenOut: Joi.string().required(),
  amountOut: FieldValidator.amount.required(),
  cosigner: FieldValidator.address.required(),
  filler: FieldValidator.address.required(),
  quoteId: FieldValidator.uuid.required(),
});

export type V2RfqResponse = {
  tokenInChainId: number;
  tokenOutChainId: number;
  requestId: string;
  tokenIn: string;
  amountIn: string;
  tokenOut: string;
  amountOut: string;
  cosigner: string;
  quoteId: string;
  filler: string;
};
