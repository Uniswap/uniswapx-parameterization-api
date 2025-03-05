import Joi from 'joi';

import { FieldValidator } from '../../util/fieldValidator';

export const SynthSwitchQueryParamsJoi = Joi.object({
  tokenIn: FieldValidator.address.required(),
  tokenInChainId: FieldValidator.chainId.required(),
  tokenOut: FieldValidator.address.required(),
  tokenOutChainId: FieldValidator.chainId.required(),
  type: FieldValidator.tradeType.required(),
  amount: FieldValidator.amount.required(), // tokenInAmount if EXACT_INPUT, tokenOutAmount if EXACT_OUTPUT
});

export type SynthSwitchQueryParams = SynthSwitchTrade & {
  amount: string;
};

export type SynthSwitchTrade = {
  tokenInChainId: number;
  tokenOutChainId: number;
  tokenIn: string;
  tokenOut: string;
  type: string;
};

export const SynthSwitchResponseJoi = Joi.object({
  enabled: Joi.boolean().required(),
});

export type SynthSwitchResponse = {
  enabled: boolean;
};
