import { BigNumber, ethers } from 'ethers';

export function validateAddress(address: string): string | undefined {
  if (!ethers.utils.isAddress(address)) {
    throw new Error('Invalid address');
  }

  // normalizes checksum and adds 0x prefix
  return ethers.utils.getAddress(address);
}

export function validateAmount(amount: string): BigNumber | undefined {
  try {
    return BigNumber.from(amount);
  } catch {
    // bignumber error is a little ugly for API response so rethrow our own
    throw new Error('Invalid amount');
  }
}

export function validateAmountResponse(amount: BigNumber): string | undefined {
  return amount.toString();
}
