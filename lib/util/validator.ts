import { BigNumber, ethers } from 'ethers';
import Joi, { CustomHelpers } from 'joi';

import { SUPPORTED_CHAINS } from '../config/chains';

export class FieldValidator {
  public static readonly address = Joi.string().custom((value: string, helpers: CustomHelpers<string>) => {
    if (!ethers.utils.isAddress(value)) {
      return helpers.message({ custom: 'Invalid address' });
    }
    return ethers.utils.getAddress(value);
  });

  public static readonly orderHash = Joi.string().regex(this.getHexadecimalRegex(64))

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

  public static readonly chainId = Joi.number()
    .integer()
    .valid(...SUPPORTED_CHAINS);

  public static readonly requestId = Joi.string().guid({ version: 'uuidv4' });

  public static readonly tradeType = Joi.string().valid('EXACT_INPUT', 'EXACT_OUTPUT');

  public static readonly uuid = Joi.string().guid({ version: 'uuidv4' });

  // A Raw Signature is a common Signature format where the r, s and v
  //   are concatenated into a 65 byte(130 nibble) DataHexString
  public static readonly rawSignature = Joi.string().custom((value: string, helpers: CustomHelpers<string>) => {
    if (!ethers.utils.isHexString(value, 65) && !ethers.utils.isHexString(value, 64)) {
      return helpers.message({ custom: 'Signature in wrong format' });
    }
    return value;
  });

  private static getHexadecimalRegex(length?: number, maxLength = false): RegExp {
    let lengthModifier = '*'
    if (length) {
      lengthModifier = maxLength ? `{0,${length}}` : `{${length}}`
    }
    return new RegExp(`^0x[0-9,a-z,A-Z]${lengthModifier}$`)
  }
}
