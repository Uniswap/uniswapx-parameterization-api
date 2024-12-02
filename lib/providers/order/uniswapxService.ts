import axios, { AxiosError } from 'axios';
import Logger from 'bunyan';

import { OrderServiceProvider, PostOrderArgs, UniswapXServiceResponse } from '.';
import { ErrorResponse } from '../../handlers/base';
import { ErrorCode } from '../../util/errors';
import { CosignedV2DutchOrder, CosignedV3DutchOrder, OrderType } from '@uniswap/uniswapx-sdk';

const ORDER_SERVICE_TIMEOUT_MS = 2000;
const ORDER_TYPE_MAP = new Map<Function, string>([
  [CosignedV2DutchOrder, OrderType.Dutch_V2],
  [CosignedV3DutchOrder, OrderType.Dutch_V3]
]);

export class UniswapXServiceProvider implements OrderServiceProvider {
  private log: Logger;

  constructor(_log: Logger, private uniswapxServiceUrl: string) {
    this.log = _log.child({ quoter: 'UniswapXOrderService' });
  }

  async postOrder(args: PostOrderArgs): Promise<ErrorResponse | UniswapXServiceResponse> {
    const { order, signature, quoteId, requestId } = args;
    this.log.info({ orderHash: order.hash() }, 'Posting order to UniswapX Service');

    const orderType = ORDER_TYPE_MAP.get(order.constructor);
    if (!orderType) {
      throw new Error(`Unsupported order type: ${order.constructor.name}`);
    }

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
          requestId: requestId,
          orderType: orderType,
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
