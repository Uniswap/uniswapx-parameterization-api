export enum ChainId {
  MAINNET = 1,
  GÖRLI = 5,
  POLYGON = 137,
  SEPOLIA = 11155111,
  ARBITRUM_ONE = 42161,
}

export const supportedChains = [
  ChainId.MAINNET,
  ChainId.ARBITRUM_ONE,
]

export enum ChainName {
  // ChainNames match infura network strings
  MAINNET = 'mainnet',
  GÖRLI = 'goerli',
  POLYGON = 'polygon',
  SEPOLIA = 'sepolia',
  ARBITRUM_ONE = 'arbitrum-mainnet',
}

export const ID_TO_NETWORK_NAME = (id: number): ChainName => {
  switch (id) {
    case 1:
      return ChainName.MAINNET;
    case 5:
      return ChainName.GÖRLI;
    case 137:
      return ChainName.POLYGON;
    case 11155111:
      return ChainName.SEPOLIA;
    case 42161:
      return ChainName.ARBITRUM_ONE;
    default:
      throw new Error(`Unknown chain id: ${id}`);
  }
};
