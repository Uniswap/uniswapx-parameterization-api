import { UnsignedV2DutchOrder } from '@uniswap/uniswapx-sdk';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';
import { ethers, Wallet } from 'ethers';

import { ApiInjector } from '../../lib/handlers/base/api-handler';
import {
  ContainerInjected as HardContainer,
  HardQuoteHandler,
  HardQuoteRequestBody,
  RequestInjected as HardRequest,
} from '../../lib/handlers/hard-quote';
import { ContainerInjected, PostQuoteRequestBody, RequestInjected } from '../../lib/handlers/quote';
import { QuoteHandler } from '../../lib/handlers/quote/handler';
import { MockOrderServiceProvider, ProtocolVersion } from '../../lib/providers';
import { DirectQuoteAnalytics, QuoteAnalytics } from '../../lib/providers/analytics';
import { MockQuoter, Quoter } from '../../lib/quoters';
import { fakeContext, FakeCosigner, FakeFirehoseBatchWriter, hardQuoteContainer, softQuoteContainer } from '../fakes';
import { CHAIN_ID, getOrder } from '../fixtures/hard-quote';

/**
 * The Lambda adapters must flush the analytics sink before responding on every exit path,
 * including thrown ones: Lambda freezes the environment once the handler returns, and unsent puts
 * are lost with it. In direct mode no analytics log lines are written, so the log-driven path
 * cannot double-count.
 */

const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

const STREAMS = {
  QuoteRequest: 'rfq-request-direct',
  QuoteResponse: 'rfq-response-direct',
  HardRequest: 'hard-request-direct',
  HardResponse: 'hard-response-direct',
};

function requestInjected<T>(ctx: ReturnType<typeof fakeContext>['ctx']): Promise<T> {
  return Promise.resolve({ log: logger, requestId: 'test', ctx } as unknown as T);
}

function analyticsLogLines(fakes: ReturnType<typeof fakeContext>) {
  return fakes.logger.records.filter((r) => 'eventType' in r.fields);
}

describe('/quote analytics flush', () => {
  const body = (): PostQuoteRequestBody => ({
    requestId: 'b45c2d1e-7f30-4a92-8c65-1d8e4f2a9b03',
    tokenInChainId: 1,
    tokenOutChainId: 1,
    swapper: '0x0000000000000000000000000000000000000000',
    tokenIn: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    tokenOut: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    amount: ethers.utils.parseEther('1').toString(),
    type: 'EXACT_INPUT',
    numOutputs: 1,
    protocol: ProtocolVersion.V2,
  });

  const invoke = async (quoters: Quoter[], analytics: QuoteAnalytics) => {
    const fakes = fakeContext('test');
    const injector = Promise.resolve({
      getContainerInjected: () => softQuoteContainer(quoters, undefined, analytics),
      getRequestInjected: () => requestInjected<RequestInjected>(fakes.ctx),
    } as unknown as ApiInjector<ContainerInjected, RequestInjected, PostQuoteRequestBody, void>);
    const response = await new QuoteHandler('quote', injector).handler(
      { body: JSON.stringify(body()) } as APIGatewayProxyEvent,
      {} as unknown as Context
    );
    return { response, fakes };
  };

  it('sends the request and every response record before returning a quote', async () => {
    const writer = new FakeFirehoseBatchWriter();
    const direct = new DirectQuoteAnalytics(
      { QuoteRequest: STREAMS.QuoteRequest, QuoteResponse: STREAMS.QuoteResponse },
      writer
    );
    const { response, fakes } = await invoke([new MockQuoter(logger, 1, 1), new MockQuoter(logger, 2, 1)], direct);
    expect(response.statusCode).toEqual(200);
    expect(writer.parsed(STREAMS.QuoteRequest)).toEqual([expect.objectContaining({ requestId: body().requestId })]);
    expect(writer.parsed(STREAMS.QuoteResponse)).toHaveLength(2);
    expect(analyticsLogLines(fakes)).toEqual([]);
  });

  it('still sends the request record when no quoter answers (404)', async () => {
    const writer = new FakeFirehoseBatchWriter();
    const direct = new DirectQuoteAnalytics(
      { QuoteRequest: STREAMS.QuoteRequest, QuoteResponse: STREAMS.QuoteResponse },
      writer
    );
    const { response } = await invoke([], direct);
    expect(response.statusCode).toEqual(404);
    expect(writer.parsed(STREAMS.QuoteRequest)).toHaveLength(1);
  });
});

describe('/hard-quote analytics flush', () => {
  const FIXED_NOW_MS = 1_756_800_000_000;
  const swapperWallet = new Wallet(`0x${'11'.repeat(32)}`);
  const cosignerWallet = new Wallet(`0x${'22'.repeat(32)}`);
  const cosigner = new FakeCosigner(cosignerWallet);
  let dateNowSpy: jest.SpyInstance;

  beforeEach(() => {
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS);
  });
  afterEach(() => dateNowSpy.mockRestore());

  const request = async (overrides: Partial<HardQuoteRequestBody> = {}): Promise<HardQuoteRequestBody> => {
    const order: UnsignedV2DutchOrder = getOrder({
      cosigner: cosignerWallet.address,
      swapper: swapperWallet.address,
      deadline: FIXED_NOW_MS / 1000 + 1000,
    });
    const { types, domain, values } = order.permitData();
    return {
      requestId: 'b45c2d1e-7f30-4a92-8c65-1d8e4f2a9b03',
      quoteId: 'a83f397c-8ef4-4801-a9b7-6e79155049f6',
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      encodedInnerOrder: order.serialize(),
      innerSig: await swapperWallet._signTypedData(domain, types, values),
      ...overrides,
    };
  };

  const invoke = async (quoters: Quoter[], analytics: QuoteAnalytics, reqBody: HardQuoteRequestBody) => {
    const fakes = fakeContext('test');
    const injector = Promise.resolve({
      getContainerInjected: () =>
        hardQuoteContainer({
          quoters,
          orderServiceProvider: new MockOrderServiceProvider(),
          cosignerFactory: cosigner.factory(),
          analytics,
        }),
      getRequestInjected: () => requestInjected<HardRequest>(fakes.ctx),
    } as unknown as ApiInjector<HardContainer, HardRequest, HardQuoteRequestBody, void>);
    const response = await new HardQuoteHandler('hardQuote', injector).handler(
      { body: JSON.stringify(reqBody) } as APIGatewayProxyEvent,
      {} as unknown as Context
    );
    return { response, fakes };
  };

  const hardStreams = { HardRequest: STREAMS.HardRequest, HardResponse: STREAMS.HardResponse };

  it('sends the request and response records of a posted order, and no quote-response records', async () => {
    const writer = new FakeFirehoseBatchWriter();
    const { response, fakes } = await invoke(
      [new MockQuoter(logger, 1, 1)],
      new DirectQuoteAnalytics(hardStreams, writer),
      await request()
    );
    expect(response.statusCode).toEqual(200);
    expect(writer.parsed(STREAMS.HardRequest)).toHaveLength(1);
    expect(writer.parsed(STREAMS.HardResponse)).toHaveLength(1);
    expect(writer.puts.map((p) => p.streamName).sort()).toEqual([STREAMS.HardRequest, STREAMS.HardResponse]);
    expect(analyticsLogLines(fakes)).toEqual([]);
  });

  it('sends the open-order response record when no quoter answers and allowNoQuote is set', async () => {
    const writer = new FakeFirehoseBatchWriter();
    const { response } = await invoke(
      [],
      new DirectQuoteAnalytics(hardStreams, writer),
      await request({ allowNoQuote: true })
    );
    expect(response.statusCode).toEqual(200);
    expect(writer.parsed(STREAMS.HardResponse)).toEqual([expect.objectContaining({ offerer: swapperWallet.address })]);
  });

  it('still sends the request record when the flow throws (404 no quotes)', async () => {
    const writer = new FakeFirehoseBatchWriter();
    const { response } = await invoke([], new DirectQuoteAnalytics(hardStreams, writer), await request());
    expect(response.statusCode).toEqual(404);
    expect(writer.parsed(STREAMS.HardRequest)).toHaveLength(1);
  });
});
