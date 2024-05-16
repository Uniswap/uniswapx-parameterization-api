import { OrderServiceProvider, PostOrderArgs, UniswapXServiceResponse } from '.';
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
