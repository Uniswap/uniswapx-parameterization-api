import { Order } from '@uniswap/uniswapx-sdk';
import { OrderServiceProvider } from '.';

export class MockOrderServiceProvider implements OrderServiceProvider {
  public orders: string[] = [];

  constructor() {}

  async postOrder(order: Order, _signature: string, _quoteId?: string): Promise<void> {
    this.orders.push(order.serialize());
  }
}
