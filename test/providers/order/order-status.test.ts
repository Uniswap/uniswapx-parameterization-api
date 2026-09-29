import { default as Logger } from 'bunyan';

import {
  ORDER_SERVICE_MAX_ORDER_HASHES,
  ORDER_STATUS_TIMEOUT_MS,
  UniswapXServiceProvider,
} from '../../../lib/providers/order/uniswapxService';
import { FakeFetch, fetchTimeoutError } from '../../fakes';

const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

const SERVICE_URL = 'https://api.example.com/';
const hash = (i: number) => `0x${i.toString(16).padStart(64, '0')}`;

// The status read only GETs: each test queues exactly the bodies it expects to be asked for.
const answering = (...bodies: unknown[]) => new FakeFetch().reply('GET', ...bodies.map((data) => ({ data })));

describe('UniswapXServiceProvider getOrdersByHashes', () => {
  it('queries GET /dutch-auction/orders with a comma-joined orderHashes param and a bounded timeout', async () => {
    const http = answering({ orders: [] });
    const provider = new UniswapXServiceProvider(logger, SERVICE_URL, http.fetch);

    await provider.getOrdersByHashes([hash(1), hash(2)]);

    expect(http.calls).toEqual([
      {
        method: 'GET',
        url: `${SERVICE_URL}dutch-auction/orders?orderHashes=${hash(1)},${hash(2)}`,
        headers: {},
        timeoutMs: ORDER_STATUS_TIMEOUT_MS,
      },
    ]);
  });

  it('maps status and fill timing, lowercases hashes, and drops malformed items', async () => {
    const http = answering({
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
    const provider = new UniswapXServiceProvider(logger, SERVICE_URL, http.fetch);

    const statuses = await provider.getOrdersByHashes([hash(1), hash(2), hash(3), hash(4)]);

    expect(statuses).toEqual([
      { orderHash: hash(1), orderStatus: 'filled', fillBlock: 123, fillTimestamp: 456 },
      { orderHash: hash(2), orderStatus: 'expired' },
      // a non-numeric fillBlock is dropped rather than coerced; the classifier will flag it
      { orderHash: hash(3), orderStatus: 'filled' },
    ]);
  });

  it('returns [] for an empty batch without calling the service', async () => {
    const http = answering();
    const provider = new UniswapXServiceProvider(logger, SERVICE_URL, http.fetch);

    expect(await provider.getOrdersByHashes([])).toEqual([]);
    expect(http.calls).toEqual([]);
  });

  it('returns [] when the body has no orders array', async () => {
    const provider = new UniswapXServiceProvider(logger, SERVICE_URL, answering({ detail: 'weird' }).fetch);
    expect(await provider.getOrdersByHashes([hash(1)])).toEqual([]);
  });

  it('refuses a batch over the order service cap instead of sending a request that would 400', async () => {
    const http = answering({ orders: [] });
    const provider = new UniswapXServiceProvider(logger, SERVICE_URL, http.fetch);
    const tooMany = Array.from({ length: ORDER_SERVICE_MAX_ORDER_HASHES + 1 }, (_, i) => hash(i + 1));

    await expect(provider.getOrdersByHashes(tooMany)).rejects.toThrow(/exceeds the order service cap/);
    expect(http.calls).toEqual([]);
    await expect(provider.getOrdersByHashes(tooMany.slice(1))).resolves.toEqual([]);
  });

  it('propagates transport failures so the caller can count the batch and move on', async () => {
    const provider = new UniswapXServiceProvider(
      logger,
      SERVICE_URL,
      new FakeFetch().reply('GET', fetchTimeoutError()).fetch
    );
    await expect(provider.getOrdersByHashes([hash(1)])).rejects.toThrow('timeout of 5000ms exceeded');
  });
});
