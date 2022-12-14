import { BigNumber, ethers } from 'ethers';
import Joi, { CustomHelpers } from 'joi';

export class FieldValidator {
  public static readonly address = Joi.string().custom((value: string, helpers: CustomHelpers<string>) => {
    if (!ethers.utils.isAddress(value)) {
      return helpers.message({ custom: 'Invalid address' });
    }
    return ethers.utils.getAddress(value);
  });

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
}
