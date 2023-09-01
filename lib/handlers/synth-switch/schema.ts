import Joi from 'joi';

import { FieldValidator } from '../../util/validator';

export const SynthSwitchQueryParamsJoi = Joi.object({
  inputToken: FieldValidator.address.required(),
  inputTokenChainId: FieldValidator.chainId.required(),
  outputToken: FieldValidator.address.required(),
  outputTokenChainId: FieldValidator.chainId.required(),
  type: FieldValidator.tradeType.required(),
  amount: FieldValidator.amount.required(), // tokenInAmount if EXACT_INPUT, tokenOutAmount if EXACT_OUTPUT
});

export type SynthSwitchQueryParams = SynthSwitchTrade & {
  amount: string;
};

export type SynthSwitchTrade = {
  inputTokenChainId: number;
  outputTokenChainId: number;
  inputToken: string;
  outputToken: string;
  type: string;
};

export const SynthSwitchResponseJoi = Joi.object({
  enabled: Joi.boolean().required(),
});

export type SynthSwitchResponse = {
  enabled: boolean;
};
