import { ChainId } from '../util/chains';

// Chains accepted by the Joi `chainId` validator on incoming requests. This
// list governs whether a request is even allowed in; per-order-type guarding
// (V2/V3/etc.) is enforced upstream by x-service. Keep in sync with the V3
// multi-chain rollout (ECO-365).
export const SUPPORTED_CHAINS: ChainId[] = [
  ChainId.MAINNET,
  ChainId.OPTIMISM,
  ChainId.BNB,
  ChainId.GÖRLI,
  ChainId.UNICHAIN,
  ChainId.POLYGON,
  ChainId.MONAD,
  ChainId.XLAYER,
  ChainId.WORLDCHAIN,
  ChainId.SONEIUM,
  ChainId.TEMPO,
  ChainId.ZORA,
  ChainId.BASE,
  ChainId.SEPOLIA,
  ChainId.ARBITRUM_ONE,
  ChainId.CELO,
  ChainId.AVALANCHE,
  ChainId.BLAST,
];
