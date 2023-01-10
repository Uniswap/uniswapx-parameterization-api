export enum ChainId {
  MAINNET = 1,
  GÖRLI = 5,
  TENDERLY = 'TENDERLY',
}

export enum ChainName {
  // ChainNames match infura network strings
  MAINNET = 'mainnet',
  GÖRLI = 'goerli',
}

export const ID_TO_NETWORK_NAME = (id: number): ChainName => {
  switch (id) {
    case 1:
      return ChainName.MAINNET;
    case 5:
      return ChainName.GÖRLI;
    default:
      throw new Error(`Unknown chain id: ${id}`);
  }
};
