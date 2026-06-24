import { ChainId } from '@uniswap/sdk-core';

export { ChainId };

/**
 * Mainnet chains we accept orders on and provision Lambda RPC providers for.
 * Single source of truth — used by both the soft/hard-quote injectors and the
 * Joi `chainId` validator (the latter additionally allows TESTNET_CHAINS for
 * integ tests).
 */
export const SUPPORTED_CHAINS: ChainId[] = [
  ChainId.MAINNET,
  ChainId.OPTIMISM,
  ChainId.BNB,
  ChainId.UNICHAIN,
  ChainId.POLYGON,
  ChainId.MONAD,
  ChainId.XLAYER,
  ChainId.WORLDCHAIN,
  ChainId.SONEIUM,
  ChainId.TEMPO,
  ChainId.ZORA,
  ChainId.BASE,
  ChainId.ARBITRUM_ONE,
  ChainId.CELO,
  ChainId.AVALANCHE,
  ChainId.BLAST,
  ChainId.ROBINHOOD,
  ChainId.ARC,
];

/**
 * Testnets accepted by the Joi `chainId` validator only — used by integ tests
 * on Sepolia and the legacy Görli routing fallback. Not provisioned with a
 * Lambda RPC provider.
 */
export const TESTNET_CHAINS: ChainId[] = [ChainId.GOERLI, ChainId.SEPOLIA];

/**
 * Resolve the RPC URL for a given chainId by appending it to RPC_PREFIX_URL.
 * Throws if the prefix is not set.
 */
export const getRpcUrl = (chainId: number): string => {
  const prefix = process.env.RPC_PREFIX_URL;
  if (!prefix) {
    throw new Error(`No RPC for chain ${chainId}: set RPC_PREFIX_URL`);
  }
  return `${prefix.replace(/\/$/, '')}/${chainId}`;
};
