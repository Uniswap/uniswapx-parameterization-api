import { default as Logger } from 'bunyan';

import {
  ORDER_SERVICE_MAX_ORDER_HASHES,
  ORDER_STATUS_TIMEOUT_MS,
  OrderServiceHttp,
  UniswapXServiceProvider,
} from '../../../lib/providers/order/uniswapxService';

const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

const SERVICE_URL = 'https://api.example.com/';
const hash = (i: number) => `0x${i.toString(16).padStart(64, '0')}`;

// Records every GET and answers with a canned body; no axios module mocking.
class FakeHttp implements OrderServiceHttp {
  public calls: { url: string; config: unknown }[] = [];
  constructor(private readonly body: unknown = {}, private readonly error?: Error) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get = async (url: string, config?: unknown): Promise<any> => {
    this.calls.push({ url, config });
    if (this.error) throw this.error;
    return { status: 200, data: this.body };
  };
}

describe('UniswapXServiceProvider getOrdersByHashes', () => {
  it('queries GET /dutch-auction/orders with a comma-joined orderHashes param and a bounded timeout', async () => {
    const http = new FakeHttp({ orders: [] });
    const provider = new UniswapXServiceProvider(logger, SERVICE_URL, http);

    await provider.getOrdersByHashes([hash(1), hash(2)]);

    expect(http.calls).toEqual([
      {
        url: `${SERVICE_URL}dutch-auction/orders`,
        config: { params: { orderHashes: `${hash(1)},${hash(2)}` }, timeout: ORDER_STATUS_TIMEOUT_MS },
      },
    ]);
  });

  it('maps status and fill timing, lowercases hashes, and drops malformed items', async () => {
    const http = new FakeHttp({
      orders: [
        {
          orderHash: hash(1).toUpperCase().replace('0X', '0x'),
          orderStatus: 'filled',
          fillBlock: 123,
          fillTimestamp: 456,
          extra: 'x',
        },
        { orderHash: hash(2), orderStatus: 'expired' },
        { orderHash: hash(3), orderStatus: 'filled', fillBlock: '123' },
        { orderStatus: 'open' },
        'garbage',
        null,
      ],
    });
    const provider = new UniswapXServiceProvider(logger, SERVICE_URL, http);

    const statuses = await provider.getOrdersByHashes([hash(1), hash(2), hash(3), hash(4)]);

    expect(statuses).toEqual([
      { orderHash: hash(1), orderStatus: 'filled', fillBlock: 123, fillTimestamp: 456 },
      { orderHash: hash(2), orderStatus: 'expired' },
      // a non-numeric fillBlock is dropped rather than coerced; the classifier will flag it
      { orderHash: hash(3), orderStatus: 'filled' },
    ]);
  });

  it('returns [] for an empty batch without calling the service', async () => {
    const http = new FakeHttp();
    const provider = new UniswapXServiceProvider(logger, SERVICE_URL, http);

    expect(await provider.getOrdersByHashes([])).toEqual([]);
    expect(http.calls).toEqual([]);
  });

  it('returns [] when the body has no orders array', async () => {
    const provider = new UniswapXServiceProvider(logger, SERVICE_URL, new FakeHttp({ detail: 'weird' }));
    expect(await provider.getOrdersByHashes([hash(1)])).toEqual([]);
  });

  it('refuses a batch over the order service cap instead of sending a request that would 400', async () => {
    const http = new FakeHttp({ orders: [] });
    const provider = new UniswapXServiceProvider(logger, SERVICE_URL, http);
    const tooMany = Array.from({ length: ORDER_SERVICE_MAX_ORDER_HASHES + 1 }, (_, i) => hash(i + 1));

    await expect(provider.getOrdersByHashes(tooMany)).rejects.toThrow(/exceeds the order service cap/);
    expect(http.calls).toEqual([]);
    await expect(provider.getOrdersByHashes(tooMany.slice(1))).resolves.toEqual([]);
  });

  it('propagates transport failures so the caller can count the batch and move on', async () => {
    const provider = new UniswapXServiceProvider(
      logger,
      SERVICE_URL,
      new FakeHttp(undefined, new Error('timeout of 5000ms exceeded'))
    );
    await expect(provider.getOrdersByHashes([hash(1)])).rejects.toThrow('timeout of 5000ms exceeded');
  });
});
