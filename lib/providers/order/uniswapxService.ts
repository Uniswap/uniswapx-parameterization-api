import axios, { AxiosError } from 'axios';
import Logger from 'bunyan';

import { OrderServiceProvider, PostOrderArgs, UniswapXServiceResponse } from '.';
import { ErrorResponse } from '../../handlers/base';
import { ErrorCode } from '../../util/errors';
import { CosignedV2DutchOrder, CosignedV3DutchOrder, OrderType } from '@uniswap/uniswapx-sdk';

// The order service validates on-chain (RPC) before accepting, so its tail can
// exceed a couple of seconds; this must stay below the hard-quote Lambda budget
// (30s) and below TAPI's hard-quote client timeout.
const ORDER_SERVICE_TIMEOUT_MS = 7000;
// Posting is processed server-side even if our request times out, so before
// reporting failure we check whether the order was actually accepted.
const ORDER_RECONCILE_DELAY_MS = 500;
const ORDER_RECONCILE_TIMEOUT_MS = 2000;

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
    const orderHash = order.hash();
    this.log.info({ orderHash }, 'Posting order to UniswapX Service');

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
      this.log.info({ response: response, orderHash }, 'Order posted to UniswapX Service');
      return {
        statusCode: response.status,
        data: response.data,
      };
    } catch (e) {
      if (e instanceof AxiosError) {
        // No response means we timed out or the connection dropped — the order
        // service may still have accepted the order (its Lambda keeps running
        // after we hang up), so the outcome is indeterminate, not a rejection.
        // Reporting it as a failure makes clients treat a live, fillable order
        // as rejected (SWAP-2839), so reconcile before reporting.
        if (!e.response) {
          this.log.warn({ orderHash, code: e.code, error: e.message }, 'Order post timed out; reconciling');
          const accepted = await this.orderExists(order.chainId, orderHash);
          if (accepted) {
            this.log.info({ orderHash }, 'Order accepted by UniswapX Service despite post timeout');
            return {
              statusCode: 201,
              data: { hash: orderHash },
            };
          }
          this.log.error({ orderHash, error: e.message }, 'Order post timed out and order was not found');
          return {
            statusCode: 500,
            errorCode: ErrorCode.InternalError,
            detail: `Timed out posting order to UniswapX Service and order was not found; status unknown (orderHash: ${orderHash})`,
          };
        }
        this.log.error({ error: e.response?.data, httpStatus: e.response?.status, code: e.code }, 'Error posting order to UniswapX Service');
        return {
          statusCode: (e.response?.status ?? 500) as ErrorResponse['statusCode'],
          errorCode: e.response?.data?.errorCode ?? ErrorCode.InternalError,
          detail: e.response?.data?.detail ?? e.message,
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

  private async orderExists(chainId: number, orderHash: string): Promise<boolean> {
    try {
      // Give the order service's in-flight request a moment to persist.
      await new Promise((resolve) => setTimeout(resolve, ORDER_RECONCILE_DELAY_MS));
      const response = await axios.get(`${this.uniswapxServiceUrl}dutch-auction/orders`, {
        params: { chainId, orderHash },
        timeout: ORDER_RECONCILE_TIMEOUT_MS,
      });
      return Array.isArray(response.data?.orders) && response.data.orders.length > 0;
    } catch (e) {
      this.log.error({ orderHash, error: e instanceof Error ? e.message : e }, 'Failed to reconcile order post');
      return false;
    }
  }
}
