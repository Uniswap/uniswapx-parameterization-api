import { Protocol } from '@uniswap/router-sdk';
import { AlphaRouterConfig } from '@uniswap/smart-order-router';

import { ChainId } from '../util/chains';

export const DEFAULT_ROUTING_CONFIG_BY_CHAIN = (chainId: ChainId): AlphaRouterConfig => {
  switch (chainId) {
    case ChainId.MAINNET:
    case ChainId.GÖRLI:
    default:
      return {
        v2PoolSelection: {
          topN: 3,
          topNDirectSwaps: 1,
          topNTokenInOut: 5,
          topNSecondHop: 2,
          topNWithEachBaseToken: 2,
          topNWithBaseToken: 6,
        },
        v3PoolSelection: {
          topN: 2,
          topNDirectSwaps: 2,
          topNTokenInOut: 3,
          topNSecondHop: 1,
          topNWithEachBaseToken: 3,
          topNWithBaseToken: 5,
        },
        v4PoolSelection: {
          topN: 2,
          topNDirectSwaps: 2,
          topNTokenInOut: 3,
          topNSecondHop: 1,
          topNWithEachBaseToken: 3,
          topNWithBaseToken: 5,
        },
        maxSwapsPerPath: 3,
        minSplits: 1,
        maxSplits: 7,
        distributionPercent: 5,
        forceCrossProtocol: false,
        protocols: [Protocol.V3],
      };
  }
};
