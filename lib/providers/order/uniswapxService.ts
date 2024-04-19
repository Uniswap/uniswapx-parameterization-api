import { Order } from '@uniswap/uniswapx-sdk';
import axios, { AxiosError } from 'axios';
import Logger from 'bunyan';

import { OrderServiceProvider, UniswapXServiceResponse } from '.';
import { ErrorResponse } from '../../handlers/base';
import { ErrorCode } from '../../util/errors';

const ORDER_SERVICE_TIMEOUT_MS = 2000;
const V2_ORDER_TYPE = 'Dutch_V2';

export class UniswapXServiceProvider implements OrderServiceProvider {
  private log: Logger;

  constructor(_log: Logger, private uniswapxServiceUrl: string) {
    this.log = _log.child({ quoter: 'UniswapXOrderService' });
  }

  async postOrder(order: Order, signature: string, quoteId?: string): Promise<ErrorResponse | UniswapXServiceResponse> {
    this.log.info({ orderHash: order.hash() }, 'Posting order to UniswapX Service');

    const axiosConfig = {
      timeout: ORDER_SERVICE_TIMEOUT_MS,
    };
    try {
      const response = await axios.post(
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
      this.log.info({ response: response, orderHash: order.hash() }, 'Order posted to UniswapX Service');
      return {
        statusCode: response.status,
        data: response.data,
      };
    } catch (e) {
      if (e instanceof AxiosError) {
        this.log.error({ error: e.response?.data }, 'Error posting order to UniswapX Service');
        return {
          statusCode: e.response?.data.statusCode,
          errorCode: e.response?.data.errorCode,
          detail: e.response?.data.detail,
        };
      } else {
        this.log.error({ error: e }, 'Unknown error posting order to UniswapX Service');
        return {
          statusCode: 500,
          errorCode: ErrorCode.InternalError,
          detail: 'Unknown Error posting to UniswapX Service',
        };
      }
    }
  }
}
