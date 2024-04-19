import { Order } from '@uniswap/uniswapx-sdk';

import { OrderServiceProvider, UniswapXServiceResponse } from '.';
import { ErrorResponse } from '../../handlers/base';

export class MockOrderServiceProvider implements OrderServiceProvider {
  public orders: string[] = [];

  constructor() {}

  async postOrder(
    order: Order,
    _signature: string,
    _quoteId?: string
  ): Promise<ErrorResponse | UniswapXServiceResponse> {
    this.orders.push(order.serialize());
    return {
      statusCode: 200,
      data: 'Order posted',
    };
  }
}
