export enum ChainId {
  MAINNET = 1,
  GÖRLI = 5,
  POLYGON = 137,
}

export enum ChainName {
  // ChainNames match infura network strings
  MAINNET = 'mainnet',
  GÖRLI = 'goerli',
  POLYGON = 'polygon',
}

export const ID_TO_NETWORK_NAME = (id: number): ChainName => {
  switch (id) {
    case 1:
      return ChainName.MAINNET;
    case 5:
      return ChainName.GÖRLI;
    case 137:
      return ChainName.POLYGON;
    default:
      throw new Error(`Unknown chain id: ${id}`);
  }
};
