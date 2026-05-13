export enum ChainId {
  MAINNET = 1,
  GÖRLI = 5,
  OPTIMISM = 10,
  BNB = 56,
  UNICHAIN = 130,
  POLYGON = 137,
  MONAD = 143,
  XLAYER = 196,
  WORLDCHAIN = 480,
  SONEIUM = 1868,
  TEMPO = 4217,
  ZORA = 7777777,
  BASE = 8453,
  SEPOLIA = 11155111,
  ARBITRUM_ONE = 42161,
  CELO = 42220,
  AVALANCHE = 43114,
  BLAST = 81457,
}

/**
 * Resolve the RPC URL for a given chainId. Per-chain `RPC_<chainId>` env
 * vars take precedence over the shared `RPC_PREFIX_URL` so individual chains
 * can be pointed at a different provider when needed; otherwise the chainId
 * is appended to `RPC_PREFIX_URL` to form the full URL. Throws if neither is
 * set.
 */
export const getRpcUrl = (chainId: number): string => {
  const override = process.env[`RPC_${chainId}`];
  if (override) return override;

  const prefix = process.env.RPC_PREFIX_URL;
  if (!prefix) {
    throw new Error(`No RPC for chain ${chainId}: set RPC_${chainId} or RPC_PREFIX_URL`);
  }
  return `${prefix.replace(/\/$/, '')}/${chainId}`;
};

// Chains where the V3 cosigner is enabled.
export const supportedChains = [
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
];
