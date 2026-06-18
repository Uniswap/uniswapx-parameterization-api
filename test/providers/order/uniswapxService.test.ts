import { CosignedV2DutchOrder } from '@uniswap/uniswapx-sdk';
import axios, { AxiosError } from 'axios';
import { default as Logger } from 'bunyan';

import { ErrorResponse } from '../../../lib/handlers/base';
import { UniswapXServiceProvider } from '../../../lib/providers/order';
import { ErrorCode } from '../../../lib/util/errors';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

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

describe('UniswapXServiceProvider postOrder', () => {
  const provider = new UniswapXServiceProvider(logger, SERVICE_URL);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns the order service response on success', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 201, data: { hash: ORDER_HASH } });

    const response = await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' });

    expect(response).toEqual({ statusCode: 201, data: { hash: ORDER_HASH } });
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${SERVICE_URL}dutch-auction/order`,
      expect.objectContaining({ encodedOrder: '0xencoded', chainId: 1 }),
      { timeout: 7000 }
    );
  });

  it('passes through a genuine rejection from the order service', async () => {
    const error = new AxiosError('Request failed with status code 400');
    error.response = {
      status: 400,
      data: { errorCode: 'VALIDATION_ERROR', detail: 'Order expired' },
    } as never;
    mockedAxios.post.mockRejectedValueOnce(error);

    const response = (await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' })) as ErrorResponse;

    expect(response.statusCode).toEqual(400);
    expect(response.detail).toEqual('Order expired');
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('reconciles a timeout and reports success when the order was accepted', async () => {
    mockedAxios.post.mockRejectedValueOnce(buildTimeoutError());
    mockedAxios.get.mockResolvedValueOnce({ data: { orders: [{ orderHash: ORDER_HASH }] } });

    const response = await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' });

    expect(response).toEqual({ statusCode: 201, data: { hash: ORDER_HASH } });
    expect(mockedAxios.get).toHaveBeenCalledWith(`${SERVICE_URL}dutch-auction/orders`, {
      params: { chainId: 1, orderHash: ORDER_HASH },
      timeout: 2000,
    });
  });

  it('returns a 500 when a timed-out order cannot be found on reconcile', async () => {
    mockedAxios.post.mockRejectedValueOnce(buildTimeoutError());
    mockedAxios.get.mockResolvedValueOnce({ data: { orders: [] } });

    const response = (await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' })) as ErrorResponse;

    expect(response.statusCode).toEqual(500);
    expect(response.errorCode).toEqual(ErrorCode.InternalError);
    // The order may still be live, so the caller gets the hash to reconcile,
    // in the same { hash } shape as a success response.
    expect(response.data).toEqual({ hash: ORDER_HASH });
  });

  it('returns a 500 with the order hash when the reconcile request itself fails', async () => {
    mockedAxios.post.mockRejectedValueOnce(buildTimeoutError());
    mockedAxios.get.mockRejectedValueOnce(new Error('network down'));

    const response = (await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' })) as ErrorResponse;

    expect(response.statusCode).toEqual(500);
    expect(response.errorCode).toEqual(ErrorCode.InternalError);
    expect(response.data).toEqual({ hash: ORDER_HASH });
  });

  it('does not attach order data to a genuine rejection', async () => {
    const error = new AxiosError('Request failed with status code 400');
    error.response = {
      status: 400,
      data: { errorCode: 'VALIDATION_ERROR', detail: 'Order expired' },
    } as never;
    mockedAxios.post.mockRejectedValueOnce(error);

    const response = (await provider.postOrder({ order: buildOrderStub(), signature: '0xsig' })) as ErrorResponse;

    expect(response.statusCode).toEqual(400);
    expect(response.data).toBeUndefined();
  });
});
