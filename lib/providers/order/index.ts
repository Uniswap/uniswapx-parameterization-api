import { Order } from '@uniswap/uniswapx-sdk';
import { ErrorResponse } from '../../handlers/base';

export interface OrderServiceProvider {
  postOrder(order: Order, signature: string, quoteId?: string): Promise<ErrorResponse | void>;
}

export * from './mock';
export * from './uniswapxService';
