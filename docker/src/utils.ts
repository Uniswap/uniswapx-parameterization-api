import { BigNumber, ethers } from 'ethers';
import Joi, { CustomHelpers } from 'joi';

class FieldValidator {
  private static readonly _address = Joi.string().custom((value: string, helpers: CustomHelpers<string>) => {
    if (!ethers.utils.isAddress(value)) {
      return helpers.message({ custom: 'Invalid address' });
    }
    return ethers.utils.getAddress(value);
  });
  public static get address() {
    return FieldValidator._address;
  }

  public static readonly amount = Joi.string().custom((value: string, helpers: CustomHelpers<string>) => {
    try {
      const result = BigNumber.from(value);
      if (result.lt(0)) {
        return helpers.message({ custom: 'Invalid amount' });
      }
    } catch {
      // bignumber error is a little ugly for API response so rethrow our own
      return helpers.message({ custom: 'Invalid amount' });
    }
    return value;
  });

  public static readonly chainId = Joi.number().integer().valid(1);

  public static readonly requestId = Joi.string().guid({ version: 'uuidv4' });

  public static readonly tradeType = Joi.string().valid('EXACT_INPUT', 'EXACT_OUTPUT');
}

export const RfqRequestBodyJoi = Joi.object({
  requestId: FieldValidator.requestId.required(),
  tokenInChainId: FieldValidator.chainId.required(),
  tokenOutChainId: FieldValidator.chainId.required(),
  offerer: FieldValidator.address.required(),
  tokenIn: FieldValidator.address.required(),
  tokenOut: FieldValidator.address.required(),
  amount: FieldValidator.amount.required(),
  type: FieldValidator.tradeType.required(),
});

export type RfqRequestBody = {
  requestId: string;
  tokenInChainId: number;
  tokenOutChainId: number;
  offerer: string;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  type: string;
};
