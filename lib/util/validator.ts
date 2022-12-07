import { BigNumber, ethers } from 'ethers';
import Joi, { CustomHelpers } from 'joi';

export class RequestFieldValidator {
  public static readonly address = Joi.string().custom((value: string, helpers: CustomHelpers<string>) => {
    if (!ethers.utils.isAddress(value)) {
      return helpers.message({ custom: 'Invalid address' });
    }
    return ethers.utils.getAddress(value);
  });

  public static readonly amount = Joi.string().custom((value: string, helpers: CustomHelpers<string>) => {
    try {
      return BigNumber.from(value);
    } catch {
      // bignumber error is a little ugly for API response so rethrow our own
      return helpers.message({ custom: 'Invalid amount' });
    }
  });
}

export class ResponseFieldValidator {
  public static readonly amount = Joi.custom((value: BigNumber) => {
    return value.toString();
  });
}
