import {
  OrderServiceOrderStatus,
  OrderServiceProvider,
  OrderStatusProvider,
  PostOrderArgs,
  UniswapXServiceResponse,
} from '.';
import { ErrorResponse } from '../../handlers/base';

export class MockOrderServiceProvider implements OrderServiceProvider {
  public orders: string[] = [];

  async postOrder(args: PostOrderArgs): Promise<ErrorResponse | UniswapXServiceResponse> {
    const { order } = args;
    this.orders.push(order.serialize());
    return {
      statusCode: 200,
      data: 'Order posted',
    };
  }
}

/**
 * In-memory order-service read side for cron tests: seed statuses by hash, and every batch
 * requested is recorded so tests can assert batching. Unknown hashes are omitted from the
 * result, as the real service does. `failures` makes the next N calls reject.
 */
export class MockOrderStatusProvider implements OrderStatusProvider {
  public readonly statuses = new Map<string, OrderServiceOrderStatus>();
  public readonly batches: string[][] = [];
  public failures = 0;

  seed(...statuses: OrderServiceOrderStatus[]): void {
    statuses.forEach((s) => this.statuses.set(s.orderHash.toLowerCase(), s));
  }

  async getOrdersByHashes(orderHashes: string[]): Promise<OrderServiceOrderStatus[]> {
    this.batches.push([...orderHashes]);
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('mock order service unavailable');
    }
    return orderHashes.flatMap((hash) => {
      const status = this.statuses.get(hash.toLowerCase());
      return status ? [status] : [];
    });
  }
}
