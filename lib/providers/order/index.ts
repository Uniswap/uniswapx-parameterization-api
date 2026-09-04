import { Order } from '@uniswap/uniswapx-sdk';
import { ErrorResponse } from '../../handlers/base';

export interface UniswapXServiceResponse {
  statusCode: number;
  data: unknown;
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

/**
 * The order service's GET /orders view of one order, reduced to what the fade breaker
 * needs. `orderStatus` is one of open | filled | expired | cancelled | insufficient-funds |
 * error; the fill fields are set only for fills (block number / unix seconds of the fill).
 */
export interface OrderServiceOrderStatus {
  orderHash: string;
  orderStatus: string;
  fillBlock?: number;
  fillTimestamp?: number;
}

/**
 * Read side of the order service used by the fade cron. One call per batch of at most
 * ORDER_SERVICE_MAX_ORDER_HASHES hashes; orders the service does not know are simply absent
 * from the result. Rejects on transport/HTTP failure so the caller can count and move on.
 */
export interface OrderStatusProvider {
  getOrdersByHashes(orderHashes: string[]): Promise<OrderServiceOrderStatus[]>;
}

export * from './mock';
export * from './uniswapxService';
