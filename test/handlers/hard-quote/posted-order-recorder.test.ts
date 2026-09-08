import { TradeType } from '@uniswap/sdk-core';
import { MetricLoggerUnit } from '@uniswap/smart-order-router';
import {
  CosignedV2DutchOrder,
  CosignedV3DutchOrder,
  CosignerData,
  OrderType,
  V3CosignerData,
  V3DutchOrderBuilder,
} from '@uniswap/uniswapx-sdk';
import { default as Logger } from 'bunyan';
import { BigNumber, ethers } from 'ethers';

import { Metric, QuoteRequest, QuoteResponse } from '../../../lib/entities';
import {
  buildPostedOrderRecord,
  exclusiveFillerOf,
  recordPostedOrder,
} from '../../../lib/handlers/hard-quote/posted-order-recorder';
import { ProtocolVersion } from '../../../lib/providers';
import {
  FillerAddressRepository,
  MockFillerAddressRepository,
  WinningAddressClaim,
} from '../../../lib/repositories/filler-address-repository';
import {
  MockPostedOrderRepository,
  PostedOrderOutcome,
  PostedOrderRecord,
  PostedOrderRepository,
} from '../../../lib/repositories/posted-order-repository';
import { CHAIN_ID, getOrder, TOKEN_IN, TOKEN_OUT } from '../../fixtures/hard-quote';

const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

const FILLER = '0x0000000000000000000000000000000000000001';
const ENDPOINT = 'https://filler.example/rfq';
const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const REQUEST_ID = 'b45c2d1e-7f30-4a92-8c65-1d8e4f2a9b03';
// Real clock: the SDK's V3 builder rejects deadlines in the past.
const NOW_S = Math.floor(Date.now() / 1000);
const RAW_AMOUNT = BigNumber.from('1000000000000000000');
// fromUnsignedOrder stores the cosignature verbatim; hash() does not verify it.
const DUMMY_COSIGNATURE = `0x${'11'.repeat(65)}`;

/** Hand-written IMetric that records every putMetric call. */
class RecordingMetric {
  public readonly puts: { key: string; value: number; unit?: MetricLoggerUnit }[] = [];
  putMetric(key: string, value: number, unit?: MetricLoggerUnit): void {
    this.puts.push({ key, value, unit });
  }
  putDimensions(): void {
    return;
  }
  setProperty(): void {
    return;
  }
  count(key: string): number {
    return this.puts.filter((p) => p.key === key).length;
  }
}

/** Fake repository whose put either throws or never settles. */
class FailingRepository extends MockPostedOrderRepository {
  constructor(private readonly mode: 'throw' | 'hang') {
    super();
  }
  async putPostedOrder(record: PostedOrderRecord): Promise<void> {
    if (this.mode === 'throw') throw new Error('ProvisionedThroughputExceededException');
    await new Promise(() => undefined);
    await super.putPostedOrder(record);
  }
}

const quote = (filler: string | undefined = FILLER): QuoteResponse =>
  QuoteResponse.fromRequest({
    request: new QuoteRequest({
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      requestId: REQUEST_ID,
      swapper: ethers.constants.AddressZero,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amount: RAW_AMOUNT,
      type: TradeType.EXACT_INPUT,
      numOutputs: 1,
      protocol: ProtocolVersion.V2,
      quoteId: QUOTE_ID,
    }),
    amountQuoted: RAW_AMOUNT.mul(2),
    metadata: { endpoint: ENDPOINT, fillerName: 'filler' },
    filler,
  });

const v2Order = (exclusiveFiller: string, deadline = NOW_S + 1000): CosignedV2DutchOrder => {
  const unsigned = getOrder({ deadline });
  const cosignerData: CosignerData = {
    decayStartTime: NOW_S + 24,
    decayEndTime: NOW_S + 84,
    exclusiveFiller,
    exclusivityOverrideBps: BigNumber.from(100),
    inputOverride: BigNumber.from(0),
    outputOverrides: [RAW_AMOUNT.mul(2)],
  };
  return CosignedV2DutchOrder.fromUnsignedOrder(unsigned, cosignerData, DUMMY_COSIGNATURE);
};

const v3Order = (exclusiveFiller: string, deadline = NOW_S + 1000): CosignedV3DutchOrder => {
  const unsigned = new V3DutchOrderBuilder(CHAIN_ID)
    .cosigner(ethers.constants.AddressZero)
    .deadline(deadline)
    .swapper(ethers.constants.AddressZero)
    .nonce(BigNumber.from(100))
    .startingBaseFee(BigNumber.from(0))
    .input({
      token: TOKEN_IN,
      startAmount: RAW_AMOUNT,
      curve: { relativeBlocks: [], relativeAmounts: [] },
      maxAmount: RAW_AMOUNT,
      adjustmentPerGweiBaseFee: BigNumber.from(0),
    })
    .output({
      token: TOKEN_OUT,
      startAmount: RAW_AMOUNT,
      curve: { relativeBlocks: [4], relativeAmounts: [BigInt(4)] },
      recipient: ethers.constants.AddressZero,
      minAmount: RAW_AMOUNT.sub(4),
      adjustmentPerGweiBaseFee: BigNumber.from(0),
    })
    .buildPartial();
  const cosignerData: V3CosignerData = {
    decayStartBlock: 20_000_000,
    exclusiveFiller,
    exclusivityOverrideBps: BigNumber.from(25),
    inputOverride: BigNumber.from(0),
    outputOverrides: [RAW_AMOUNT.mul(2)],
  };
  return CosignedV3DutchOrder.fromUnsignedOrder(unsigned, cosignerData, DUMMY_COSIGNATURE);
};

describe('exclusiveFillerOf', () => {
  it('is undefined for the zero address and checksummed otherwise', () => {
    expect(exclusiveFillerOf(v2Order(ethers.constants.AddressZero))).toBeUndefined();
    expect(exclusiveFillerOf(v2Order(FILLER.toLowerCase()))).toEqual(FILLER);
  });
});

describe('buildPostedOrderRecord', () => {
  it('captures a V2 order with its decay start time', () => {
    const order = v2Order(FILLER);
    const record = buildPostedOrderRecord({
      order,
      quote: quote(),
      quoteId: QUOTE_ID,
      requestId: REQUEST_ID,
      postedAtMs: NOW_S * 1000 + 999,
    });
    expect(record).toEqual({
      orderHash: order.hash(),
      quoteId: QUOTE_ID,
      requestId: REQUEST_ID,
      chainId: CHAIN_ID,
      orderType: OrderType.Dutch_V2,
      fillerAddress: FILLER,
      filler: ENDPOINT,
      fillerName: 'filler',
      decayStartTime: NOW_S + 24,
      deadline: NOW_S + 1000,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      postedAt: NOW_S,
      outcome: PostedOrderOutcome.PENDING,
    });
    expect(record).not.toHaveProperty('decayStartBlock');
  });

  it('captures a V3 order with its decay start block', () => {
    const order = v3Order(FILLER);
    const record = buildPostedOrderRecord({
      order,
      quote: quote(),
      quoteId: QUOTE_ID,
      requestId: REQUEST_ID,
      postedAtMs: NOW_S * 1000,
    });
    expect(record).toMatchObject({
      orderHash: order.hash(),
      orderType: OrderType.Dutch_V3,
      decayStartBlock: 20_000_000,
      fillerAddress: FILLER,
      filler: ENDPOINT,
      deadline: NOW_S + 1000,
    });
    expect(record).not.toHaveProperty('decayStartTime');
  });

  it('refuses an order with no exclusive filler', () => {
    expect(() =>
      buildPostedOrderRecord({
        order: v2Order(ethers.constants.AddressZero),
        quote: quote(),
        quoteId: QUOTE_ID,
        requestId: REQUEST_ID,
        postedAtMs: NOW_S * 1000,
      })
    ).toThrow(/no exclusive filler/);
  });
});

describe('recordPostedOrder', () => {
  const run = (
    repository: PostedOrderRepository,
    args: Partial<Parameters<typeof recordPostedOrder>[0]> = {},
    fillerAddressRepository: FillerAddressRepository = new MockFillerAddressRepository()
  ) => {
    const metric = new RecordingMetric();
    const promise = recordPostedOrder({
      repository,
      fillerAddressRepository,
      order: v2Order(FILLER),
      quote: quote(),
      quoteId: QUOTE_ID,
      requestId: REQUEST_ID,
      log: logger,
      metric,
      ...args,
    });
    return { promise, metric };
  };

  it('writes the record and emits the success metric and latency', async () => {
    const repository = new MockPostedOrderRepository();
    const { promise, metric } = run(repository);
    await promise;

    expect(repository.records.size).toEqual(1);
    const [record] = repository.records.values();
    expect(record.filler).toEqual(ENDPOINT);
    expect(record.outcome).toEqual(PostedOrderOutcome.PENDING);
    expect(metric.count(Metric.POSTED_ORDER_RECORDED)).toEqual(1);
    expect(metric.count(Metric.POSTED_ORDER_RECORD_FAILED)).toEqual(0);
    expect(metric.count(Metric.POSTED_ORDER_RECORD_LATENCY)).toEqual(1);
  });

  it('skips open orders (no quote) and non-exclusive orders without emitting either metric', async () => {
    const repository = new MockPostedOrderRepository();
    const openOrder = run(repository, { quote: undefined, order: v2Order(ethers.constants.AddressZero) });
    await openOrder.promise;
    const nonImproving = run(repository, { order: v2Order(ethers.constants.AddressZero) });
    await nonImproving.promise;

    expect(repository.records.size).toEqual(0);
    for (const { metric } of [openOrder, nonImproving]) {
      expect(metric.puts).toEqual([]);
    }
  });

  it('swallows a repository error, emitting the failure metric', async () => {
    const { promise, metric } = run(new FailingRepository('throw'));
    await expect(promise).resolves.toBeUndefined();

    expect(metric.count(Metric.POSTED_ORDER_RECORDED)).toEqual(0);
    expect(metric.count(Metric.POSTED_ORDER_RECORD_FAILED)).toEqual(1);
    expect(metric.count(Metric.POSTED_ORDER_RECORD_LATENCY)).toEqual(1);
  });

  it('attributes the exclusive filler address to the quote endpoint alongside the record', async () => {
    const addresses = new MockFillerAddressRepository();
    const { promise, metric } = run(new MockPostedOrderRepository(), {}, addresses);
    await promise;

    expect([...addresses.addressToFiller.entries()]).toEqual([[FILLER, ENDPOINT]]);
    expect(metric.count(Metric.FILLER_ADDRESS_RECORD_FAILED)).toEqual(0);
    expect(metric.count(Metric.FILLER_ADDRESS_CLAIM_REJECTED)).toEqual(0);
  });

  it('records no address for open or non-exclusive orders', async () => {
    const addresses = new MockFillerAddressRepository();
    await run(
      new MockPostedOrderRepository(),
      { quote: undefined, order: v2Order(ethers.constants.AddressZero) },
      addresses
    ).promise;
    await run(new MockPostedOrderRepository(), { order: v2Order(ethers.constants.AddressZero) }, addresses).promise;
    expect(addresses.addressToFiller.size).toEqual(0);
  });

  it('a failing attribution write is counted on its own metric and does not affect the record', async () => {
    const addresses = new MockFillerAddressRepository();
    addresses.recordWinningAddress = async () => {
      throw new Error('ProvisionedThroughputExceededException');
    };
    const repository = new MockPostedOrderRepository();
    const { promise, metric } = run(repository, {}, addresses);
    await expect(promise).resolves.toBeUndefined();

    expect(repository.records.size).toEqual(1);
    expect(metric.count(Metric.POSTED_ORDER_RECORDED)).toEqual(1);
    expect(metric.count(Metric.POSTED_ORDER_RECORD_FAILED)).toEqual(0);
    expect(metric.count(Metric.FILLER_ADDRESS_RECORD_FAILED)).toEqual(1);
  });

  it('a refused claim (address owned by another endpoint) is counted on its own metric, not as a write failure', async () => {
    const addresses = new MockFillerAddressRepository();
    await addresses.recordWinningAddress(FILLER, 'https://first-owner.example/rfq');
    const repository = new MockPostedOrderRepository();
    const { promise, metric } = run(repository, {}, addresses);
    await expect(promise).resolves.toBeUndefined();

    expect(addresses.addressToFiller.get(FILLER)).toEqual('https://first-owner.example/rfq');
    expect(repository.records.size).toEqual(1);
    expect(metric.count(Metric.POSTED_ORDER_RECORDED)).toEqual(1);
    expect(metric.count(Metric.FILLER_ADDRESS_RECORD_FAILED)).toEqual(0);
    expect(metric.count(Metric.FILLER_ADDRESS_CLAIM_REJECTED)).toEqual(1);
  });

  it('a hung attribution write is bounded by the same wall and does not delay the record beyond it', async () => {
    const addresses = new MockFillerAddressRepository();
    addresses.recordWinningAddress = () => new Promise<WinningAddressClaim>(() => undefined);
    const repository = new MockPostedOrderRepository();
    const start = Date.now();
    const { promise, metric } = run(repository, { timeoutMs: 50 }, addresses);
    await promise;

    expect(Date.now() - start).toBeLessThan(500);
    expect(repository.records.size).toEqual(1);
    expect(metric.count(Metric.POSTED_ORDER_RECORDED)).toEqual(1);
    expect(metric.count(Metric.FILLER_ADDRESS_RECORD_FAILED)).toEqual(1);
  });

  it('a failing record write does not prevent the attribution', async () => {
    const addresses = new MockFillerAddressRepository();
    const { promise, metric } = run(new FailingRepository('throw'), {}, addresses);
    await promise;

    expect([...addresses.addressToFiller.entries()]).toEqual([[FILLER, ENDPOINT]]);
    expect(metric.count(Metric.POSTED_ORDER_RECORD_FAILED)).toEqual(1);
    expect(metric.count(Metric.FILLER_ADDRESS_RECORD_FAILED)).toEqual(0);
  });

  it('gives up on a hung write at the timeout and counts it as a failure', async () => {
    const start = Date.now();
    const { promise, metric } = run(new FailingRepository('hang'), { timeoutMs: 50 });
    await expect(promise).resolves.toBeUndefined();

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(1_000);
    expect(metric.count(Metric.POSTED_ORDER_RECORD_FAILED)).toEqual(1);
    const latency = metric.puts.find((p) => p.key === Metric.POSTED_ORDER_RECORD_LATENCY);
    expect(latency?.value).toBeGreaterThanOrEqual(45);
  });
});
