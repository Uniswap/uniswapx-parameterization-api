import { Order } from '@uniswap/uniswapx-sdk';
import { ErrorResponse } from '../../handlers/base';

export interface UniswapXServiceResponse {
  statusCode: number;
  data: string;
}

export interface PostOrderArgs {
  order: Order;
  signature: string;
  quoteId?: string;
  requestId?: string;
}

export interface OrderServiceProvider {
  postOrder(args: PostOrderArgs): Promise<ErrorResponse | UniswapXServiceResponse>;
}

export * from './mock';
export * from './uniswapxService';
