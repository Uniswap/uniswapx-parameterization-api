import Joi from 'joi';

import { FieldValidator } from '../../util/fieldValidator';

/* Hard quote request from user */
export const HardQuoteRequestBodyJoi = Joi.object({
  requestId: FieldValidator.requestId.required(),
  quoteId: FieldValidator.uuid.optional(),
  encodedInnerOrder: Joi.string().required(),
  innerSig: FieldValidator.rawSignature.required(),
  tokenInChainId: FieldValidator.chainId.required(),
  tokenOutChainId: Joi.number().integer().valid(Joi.ref('tokenInChainId')).required(),
  allowNoQuote: Joi.boolean().optional(),
  forceOpenOrder: Joi.boolean().optional(),
});

export type HardQuoteRequestBody = {
  requestId: string;
  quoteId?: string;
  encodedInnerOrder: string;
  innerSig: string;
  tokenInChainId: number;
  tokenOutChainId: number;
  allowNoQuote?: boolean;
  forceOpenOrder?: boolean;
};

export const HardQuoteResponseDataJoi = Joi.object({
  requestId: FieldValidator.uuid.required(),
  quoteId: FieldValidator.uuid,
  chainId: FieldValidator.chainId.required(),
  encodedOrder: Joi.string().required(),
  orderHash: FieldValidator.orderHash.required(),
  filler: FieldValidator.address,
});

export type HardQuoteResponseData = {
  requestId: string;
  quoteId?: string;
  chainId: number;
  encodedOrder: string;
  orderHash: string;
  filler?: string;
};
