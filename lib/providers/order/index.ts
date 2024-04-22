import { Order } from '@uniswap/uniswapx-sdk';
import { ErrorResponse } from '../../handlers/base';

export interface UniswapXServiceResponse {
  statusCode: number;
  data: string;
}

export interface OrderServiceProvider {
  postOrder(order: Order, signature: string, quoteId?: string): Promise<ErrorResponse | UniswapXServiceResponse>;
}

export * from './mock';
export * from './uniswapxService';
