import { Order } from '@uniswap/uniswapx-sdk';
import axios from 'axios';
import Logger from 'bunyan';

import { OrderServiceProvider } from '.';

const ORDER_SERVICE_TIMEOUT_MS = 500;
const V2_ORDER_TYPE = 'Dutch_V2';

export class UniswapXServiceProvider implements OrderServiceProvider {
  private log: Logger;

  constructor(_log: Logger, private uniswapxServiceUrl: string) {
    this.log = _log.child({ quoter: 'UniswapXOrderService' });
  }

  async postOrder(order: Order, signature: string, quoteId?: string): Promise<void> {
    this.log.info({ orderHash: order.hash() }, 'Posting order to UniswapX Service');

    // need to wait for lambda cold starts when CodePipeline runs integration tests after new deployment
    const axiosConfig = {
      timeout: process.env.IS_TEST ? 5000 : ORDER_SERVICE_TIMEOUT_MS,
    };

    await axios.post(
      `${this.uniswapxServiceUrl}dutch-auction/order`,
      {
        encodedOrder: order.serialize(),
        signature: signature,
        chainId: order.chainId,
        quoteId: quoteId,
        orderType: V2_ORDER_TYPE,
      },
      axiosConfig
    );
    this.log.info({ orderHash: order.hash() }, 'Order posted to UniswapX Service');
  }
}
