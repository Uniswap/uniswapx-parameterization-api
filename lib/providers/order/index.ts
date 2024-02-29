import { Order } from '@uniswap/uniswapx-sdk';

export interface OrderServiceProvider {
  postOrder(order: Order, signature: string, quoteId?: string): Promise<void>;
}

export * from './mock';
export * from './uniswapxService';
