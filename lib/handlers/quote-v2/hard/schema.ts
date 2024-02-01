import Joi from 'joi';

import { FieldValidator } from '../../../util/validator';

/* Hard quote request from user */
export const HardQuoteRequestBodyJoi = Joi.object({
  requestId: FieldValidator.requestId.required(),
  quoteId: FieldValidator.uuid.optional(),
  encodedInnerOrder: Joi.string().required(),
  innerSig: FieldValidator.rawSignature.required(),
  tokenInChainId: FieldValidator.chainId.required(),
  tokenOutChainId: FieldValidator.chainId.required(),
});

export type HardQuoteRequestBody = {
  requestId: string;
  quoteId?: string;
  encodedInnerOrder: string;
  innerSig: string;
  tokenInChainId: number;
  tokenOutChainId: number;
};
