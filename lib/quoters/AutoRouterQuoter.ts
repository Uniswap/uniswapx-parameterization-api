import DEFAULT_TOKEN_LIST from '@uniswap/default-token-list';
import { CurrencyAmount, Token, TradeType } from '@uniswap/sdk-core';
import {
  AlphaRouter,
  CachingGasStationProvider,
  CachingTokenListProvider,
  CachingTokenProviderWithFallback,
  CachingV3PoolProvider,
  EIP1559GasPriceProvider,
  GasPrice,
  ITokenProvider,
  LegacyGasPriceProvider,
  NodeJSCache,
  OnChainGasPriceProvider,
  TokenProvider,
  UniswapMulticallProvider,
  V2PoolProvider,
  V2QuoteProvider,
  V3HeuristicGasModelFactory,
  V3PoolProvider,
} from '@uniswap/smart-order-router';
import Logger from 'bunyan';
import { BigNumber, ethers } from 'ethers';
import NodeCache from 'node-cache';

import { Quoter, QuoterType } from '.';
import { SUPPORTED_CHAINS } from '../config/chains';
import { DEFAULT_ROUTING_CONFIG_BY_CHAIN } from '../config/routing';
import { QuoteRequest, QuoteResponse } from '../entities';

type Dependencies = {
  chainId: number;
  router: AlphaRouter;
  tokenProvider: ITokenProvider;
};

type DependenciesByChain = {
  [chainId: number]: Dependencies;
};

const PROVIDER_TIMEOUT_MS = 500;

// Quoter which fetches quotes from http endpoints
// endpoints must return well-formed QuoteResponse JSON
export class AutoRouterQuoter implements Quoter {
  private dependencies: DependenciesByChain;
  private log: Logger;

  // builds an autorouter to quote orders for each supported chain
  // note pre-build router dependencies can be passed, or they will be built locally if not provided
  constructor(_log: Logger, injectedDependencies?: DependenciesByChain) {
    this.log = _log.child({ quoter: 'AutoRouterQuoter' });
    this.dependencies =
      injectedDependencies ??
      SUPPORTED_CHAINS.map((chainId) => AutoRouterQuoter.getDependencies(this.log, chainId)).reduce(
        (acc: DependenciesByChain, d: Dependencies | null) => {
          if (d) {
            acc[d.chainId] = d;
          }
          return acc;
        },
        {}
      );
  }

  public type(): QuoterType {
    return QuoterType.ROUTER;
  }

  // uses the autorouter to return a fair quote for the given request
  public async quote(request: QuoteRequest): Promise<QuoteResponse[]> {
    if (!this.dependencies[request.chainId]) {
      this.log.error({ chainId: request.chainId }, 'Unsupported chain');
      return [];
    }
    const { router, tokenProvider } = this.dependencies[request.chainId];

    const { getTokenByAddress } = await tokenProvider.getTokens([request.tokenIn, request.tokenOut]);
    const [inputToken, outputToken] = [getTokenByAddress(request.tokenIn), getTokenByAddress(request.tokenOut)];

    if (!inputToken) {
      this.log.error({ chainId: request.chainId }, `Unsupported asset: ${request.tokenIn}`);
      return [];
    } else if (!outputToken) {
      this.log.error({ chainId: request.chainId }, `Unsupported asset: ${request.tokenOut}`);
      return [];
    }

    const inputAmount = CurrencyAmount.fromRawAmount(inputToken, request.amountIn.toString());

    let route;
    try {
      route = await router.route(
        inputAmount,
        outputToken,
        TradeType.EXACT_INPUT,
        undefined,
        DEFAULT_ROUTING_CONFIG_BY_CHAIN(request.chainId)
      );
    } catch (e) {
      this.log.error(`Error getting route: ${e} for request: ${request.requestId}`);
      return [];
    }

    if (!route) {
      this.log.error(`Unable to route for request: ${request.requestId}`);
      return [];
    }

    this.log.info(`Got quote: ${route.quoteGasAdjusted.quotient.toString()} for request: ${request.requestId}`);

    const quotedAmountOut = BigNumber.from(route.quoteGasAdjusted.quotient.toString());

    return [QuoteResponse.fromRequest(request, quotedAmountOut)];
  }

  // builds an alphaRouter and other required dependencies for the given chainid
  static getDependencies(log: Logger, chainId: number): Dependencies | null {
    const url = process.env[`RPC_${chainId.toString()}`];
    if (!url) {
      // cannot route without rpc url
      log.fatal({ chainId: chainId }, `Fatal: No Web3 RPC endpoint set for chain`);
      return null;
    }

    const provider = new ethers.providers.JsonRpcProvider(
      {
        url: url,
        timeout: PROVIDER_TIMEOUT_MS,
      },
      chainId
    );

    const multicallProvider = new UniswapMulticallProvider(chainId, provider);

    const gasPriceCache = new NodeJSCache<GasPrice>(new NodeCache({ stdTTL: 15, useClones: true }));

    const v3PoolProvider = new CachingV3PoolProvider(
      chainId,
      new V3PoolProvider(chainId, multicallProvider),
      new NodeJSCache(new NodeCache({ stdTTL: 180, useClones: false }))
    );

    const v2PoolProvider = new V2PoolProvider(chainId, multicallProvider);

    const gasPriceProvider = new CachingGasStationProvider(
      chainId,
      new OnChainGasPriceProvider(chainId, new EIP1559GasPriceProvider(provider), new LegacyGasPriceProvider(provider)),
      gasPriceCache
    );

    const tokenCache = new NodeJSCache<Token>(new NodeCache({ stdTTL: 3600, useClones: false }));
    const tokenListProvider = new CachingTokenListProvider(chainId, DEFAULT_TOKEN_LIST, tokenCache);
    const tokenProvider = new CachingTokenProviderWithFallback(
      chainId,
      tokenCache,
      tokenListProvider,
      new TokenProvider(chainId, multicallProvider)
    );

    const router = new AlphaRouter({
      chainId: chainId,
      provider,
      multicall2Provider: multicallProvider,
      v3PoolProvider,
      v2PoolProvider,
      gasPriceProvider,
      v3GasModelFactory: new V3HeuristicGasModelFactory(),
      tokenProvider,
      v2QuoteProvider: new V2QuoteProvider(),
    });

    return {
      chainId,
      router,
      tokenProvider,
    };
  }
}
