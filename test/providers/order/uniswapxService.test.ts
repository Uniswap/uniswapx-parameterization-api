import { CosignedV2DutchOrder } from '@uniswap/uniswapx-sdk';
import { AxiosError } from 'axios';
import { default as Logger } from 'bunyan';

import { ErrorResponse } from '../../../lib/handlers/base';
import { UniswapXServiceProvider } from '../../../lib/providers/order';
import { ErrorCode } from '../../../lib/util/errors';
import { FakeHttp } from '../../fakes';

const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

const ORDER_HASH = '0x' + 'ab'.repeat(32);
const SERVICE_URL = 'https://api.example.com/';

// ORDER_TYPE_MAP looks up the concrete sdk class via order.constructor, so the
// stub must share CosignedV2DutchOrder's prototype.
function buildOrderStub(): CosignedV2DutchOrder {
  const order = Object.create(CosignedV2DutchOrder.prototype);
  order.hash = () => ORDER_HASH;
  order.serialize = () => '0xencoded';
  order.chainId = 1;
  return order;
}

function buildTimeoutError(): AxiosError {
  return new AxiosError('timeout of 7000ms exceeded', AxiosError.ECONNABORTED);
}

function buildRejection(): AxiosError {
  const error = new AxiosError('Request failed with status code 400');
  error.response = {
    status: 400,
    data: { errorCode: 'VALIDATION_ERROR', detail: 'Order expired' },
  } as never;
  return error;
}

describe('UniswapXServiceProvider postOrder', () => {
  let http: FakeHttp;
  let provider: UniswapXServiceProvider;

  beforeEach(() => {
    http = new FakeHttp();
    provider = new UniswapXServiceProvider(logger, SERVICE_URL, http);
  });

  it('returns the order service response on success', async () => {
    http.reply('post', { status: 201, data: { hash: ORDER_HASH } });

    const response = await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' });

    expect(response).toEqual({ statusCode: 201, data: { hash: ORDER_HASH } });
    expect(http.calls).toEqual([
      {
        method: 'post',
        url: `${SERVICE_URL}dutch-auction/order`,
        body: expect.objectContaining({ encodedOrder: '0xencoded', chainId: 1 }),
        config: { timeout: 7000 },
      },
    ]);
  });

  it('passes through a genuine rejection from the order service', async () => {
    http.reply('post', buildRejection());

    const response = (await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' })) as ErrorResponse;

    expect(response.statusCode).toEqual(400);
    expect(response.detail).toEqual('Order expired');
    expect(http.callsTo('get')).toHaveLength(0);
  });

  it('reconciles a timeout and reports success when the order was accepted', async () => {
    http.reply('post', buildTimeoutError()).reply('get', { data: { orders: [{ orderHash: ORDER_HASH }] } });

    const response = await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' });

    expect(response).toEqual({ statusCode: 201, data: { hash: ORDER_HASH } });
    expect(http.callsTo('get')).toEqual([
      {
        method: 'get',
        url: `${SERVICE_URL}dutch-auction/orders`,
        config: { params: { chainId: 1, orderHash: ORDER_HASH }, timeout: 2000 },
      },
    ]);
  });

  it('returns a 500 when a timed-out order cannot be found on reconcile', async () => {
    http.reply('post', buildTimeoutError()).reply('get', { data: { orders: [] } });

    const response = (await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' })) as ErrorResponse;

    expect(response.statusCode).toEqual(500);
    expect(response.errorCode).toEqual(ErrorCode.InternalError);
    // The order may still be live, so the caller gets the hash to reconcile,
    // in the same { hash } shape as a success response.
    expect(response.data).toEqual({ hash: ORDER_HASH });
  });

  it('returns a 500 with the order hash when the reconcile request itself fails', async () => {
    http.reply('post', buildTimeoutError()).reply('get', new Error('network down'));

    const response = (await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' })) as ErrorResponse;

    expect(response.statusCode).toEqual(500);
    expect(response.errorCode).toEqual(ErrorCode.InternalError);
    expect(response.data).toEqual({ hash: ORDER_HASH });
  });

  it('does not attach order data to a genuine rejection', async () => {
    http.reply('post', buildRejection());

    const response = (await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' })) as ErrorResponse;

    expect(response.statusCode).toEqual(400);
    expect(response.data).toBeUndefined();
  });
});
