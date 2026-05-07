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

// Chains where the V3 cosigner is enabled. Keep in sync with the V3 multi-chain
// rollout (ECO-365). Linea / zkSync are deferred and intentionally absent.
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
]

export enum ChainName {
  // ChainNames match infura network strings
  MAINNET = 'mainnet',
  GÖRLI = 'goerli',
  OPTIMISM = 'optimism-mainnet',
  BNB = 'bnb-mainnet',
  UNICHAIN = 'unichain-mainnet',
  POLYGON = 'polygon',
  MONAD = 'monad-mainnet',
  XLAYER = 'xlayer-mainnet',
  WORLDCHAIN = 'worldchain-mainnet',
  SONEIUM = 'soneium-mainnet',
  TEMPO = 'tempo',
  ZORA = 'zora-mainnet',
  BASE = 'base-mainnet',
  SEPOLIA = 'sepolia',
  ARBITRUM_ONE = 'arbitrum-mainnet',
  CELO = 'celo-mainnet',
  AVALANCHE = 'avalanche-mainnet',
  BLAST = 'blast-mainnet',
}

export const ID_TO_NETWORK_NAME = (id: number): ChainName => {
  switch (id) {
    case 1:
      return ChainName.MAINNET;
    case 5:
      return ChainName.GÖRLI;
    case 10:
      return ChainName.OPTIMISM;
    case 56:
      return ChainName.BNB;
    case 130:
      return ChainName.UNICHAIN;
    case 137:
      return ChainName.POLYGON;
    case 143:
      return ChainName.MONAD;
    case 196:
      return ChainName.XLAYER;
    case 480:
      return ChainName.WORLDCHAIN;
    case 1868:
      return ChainName.SONEIUM;
    case 4217:
      return ChainName.TEMPO;
    case 7777777:
      return ChainName.ZORA;
    case 8453:
      return ChainName.BASE;
    case 11155111:
      return ChainName.SEPOLIA;
    case 42161:
      return ChainName.ARBITRUM_ONE;
    case 42220:
      return ChainName.CELO;
    case 43114:
      return ChainName.AVALANCHE;
    case 81457:
      return ChainName.BLAST;
    default:
      throw new Error(`Unknown chain id: ${id}`);
  }
};
