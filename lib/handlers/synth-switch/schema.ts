import Joi from 'joi';

import { FieldValidator } from '../../util/validator';

export const SynthSwitchRequestBodyJoi = Joi.object({
  tokenInChainId: FieldValidator.chainId.required(),
  inputTokenChainId: Joi.number().integer().valid(Joi.ref('tokenInChainId')).required(),
  outputTokenChainId: FieldValidator.address.required(),
  outputToken: FieldValidator.address.required(),
  type: FieldValidator.tradeType.required(),
  amount: FieldValidator.amount.required(), // tokenInAmount if EXACT_INPUT, tokenOutAmount if EXACT_OUTPUT
});

export type SynthSwitchRequestBody = {
  inputTokenChainId: number;
  outputTokenChainId: number;
  inputToken: string;
  outputToken: string;
  amount: string;
  type: string;
};

export const SynthSwitchResponseJoi = Joi.object({
  enabled: Joi.boolean().required(),
});

export type SynthSwitchResponse = {
  enabled: boolean;
};
