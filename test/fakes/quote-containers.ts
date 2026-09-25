import { ethers } from 'ethers';

import { HardQuoteBL, HardQuoteDeps, SoftQuoteBL } from '../../lib/core';
import { ContainerInjected as HardQuoteContainerInjected } from '../../lib/handlers/hard-quote/injector';
import { ContainerInjected as SoftQuoteContainerInjected } from '../../lib/handlers/quote/injector';
import { MockOrderServiceProvider } from '../../lib/providers/order/mock';
import { Quoter } from '../../lib/quoters';
import { MockFillerAddressRepository } from '../../lib/repositories/filler-address-repository';
import { MockPostedOrderRepository } from '../../lib/repositories/posted-order-repository';
import { ChainId } from '../../lib/util/chains';

type RpcMap = Map<ChainId, ethers.providers.StaticJsonRpcProvider>;

/** Arbitrum with an unconnected provider: enough for every path that never calls the RPC. */
export function offlineRpcMap(): RpcMap {
  return new Map([[ChainId.ARBITRUM_ONE, new ethers.providers.StaticJsonRpcProvider()]]);
}

/**
 * The /quote handler's container, with its flow built from exactly the given quoters, so a
 * harness can't hand the handler one set of quoters and the flow another.
 */
export function softQuoteContainer(
  quoters: Quoter[],
  chainIdRpcMap: RpcMap = offlineRpcMap()
): SoftQuoteContainerInjected {
  return { softQuote: new SoftQuoteBL(quoters, chainIdRpcMap) };
}

/**
 * The /hard-quote handler's container. Quoters and the cosigner are required; every other
 * dependency defaults to an in-memory mock that accepts the order.
 */
export function hardQuoteContainer(
  deps: Pick<HardQuoteDeps, 'quoters' | 'cosignerFactory'> & Partial<HardQuoteDeps>
): HardQuoteContainerInjected {
  return {
    hardQuote: new HardQuoteBL({
      chainIdRpcMap: offlineRpcMap(),
      orderServiceProvider: new MockOrderServiceProvider(),
      postedOrderRepository: new MockPostedOrderRepository(),
      fillerAddressRepository: new MockFillerAddressRepository(),
      ...deps,
    }),
  };
}
