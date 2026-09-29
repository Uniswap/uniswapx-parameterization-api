import { CosignedV2DutchOrder } from '@uniswap/uniswapx-sdk';
import { default as Logger } from 'bunyan';

import { ErrorResponse } from '../../../lib/handlers/base';
import { UniswapXServiceProvider } from '../../../lib/providers/order';
import { ErrorCode } from '../../../lib/util/errors';
import { FakeFetch, FetchReply, fetchNetworkError, fetchTimeoutError } from '../../fakes';

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

const buildTimeoutError = fetchTimeoutError;

function buildRejection(): FetchReply {
  return { status: 400, data: { errorCode: 'VALIDATION_ERROR', detail: 'Order expired' } };
}

describe('UniswapXServiceProvider postOrder', () => {
  let http: FakeFetch;
  let provider: UniswapXServiceProvider;

  beforeEach(() => {
    http = new FakeFetch();
    provider = new UniswapXServiceProvider(logger, SERVICE_URL, http.fetch);
  });

  it('returns the order service response on success', async () => {
    http.reply('POST', { status: 201, data: { hash: ORDER_HASH } });

    const response = await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' });

    expect(response).toEqual({ statusCode: 201, data: { hash: ORDER_HASH } });
    expect(http.calls).toEqual([
      {
        method: 'POST',
        url: `${SERVICE_URL}dutch-auction/order`,
        body: expect.objectContaining({ encodedOrder: '0xencoded', chainId: 1 }),
        headers: {},
        timeoutMs: 7000,
      },
    ]);
  });

  it('passes through a genuine rejection from the order service', async () => {
    http.reply('POST', buildRejection());

    const response = (await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' })) as ErrorResponse;

    expect(response.statusCode).toEqual(400);
    expect(response.detail).toEqual('Order expired');
    expect(http.callsTo('GET')).toHaveLength(0);
  });

  it('reconciles a timeout and reports success when the order was accepted', async () => {
    http.reply('POST', buildTimeoutError()).reply('GET', { data: { orders: [{ orderHash: ORDER_HASH }] } });

    const response = await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' });

    expect(response).toEqual({ statusCode: 201, data: { hash: ORDER_HASH } });
    expect(http.callsTo('GET')).toEqual([
      {
        method: 'GET',
        url: `${SERVICE_URL}dutch-auction/orders?chainId=1&orderHash=${ORDER_HASH}`,
        headers: {},
        timeoutMs: 2000,
      },
    ]);
  });

  it('returns a 500 when a timed-out order cannot be found on reconcile', async () => {
    http.reply('POST', buildTimeoutError()).reply('GET', { data: { orders: [] } });

    const response = (await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' })) as ErrorResponse;

    expect(response.statusCode).toEqual(500);
    expect(response.errorCode).toEqual(ErrorCode.InternalError);
    // The order may still be live, so the caller gets the hash to reconcile,
    // in the same { hash } shape as a success response.
    expect(response.data).toEqual({ hash: ORDER_HASH });
  });

  it('returns a 500 with the order hash when the reconcile request itself fails', async () => {
    http.reply('POST', buildTimeoutError()).reply('GET', fetchNetworkError('network down'));

    const response = (await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' })) as ErrorResponse;

    expect(response.statusCode).toEqual(500);
    expect(response.errorCode).toEqual(ErrorCode.InternalError);
    expect(response.data).toEqual({ hash: ORDER_HASH });
  });

  it('does not attach order data to a genuine rejection', async () => {
    http.reply('POST', buildRejection());

    const response = (await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' })) as ErrorResponse;

    expect(response.statusCode).toEqual(400);
    expect(response.data).toBeUndefined();
  });
});
