import { UnsignedV2DutchOrder } from '@uniswap/uniswapx-sdk';
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';
import { Wallet } from 'ethers';

import { POST_ORDER_ERROR_REASON } from '../../../lib/constants';
import { Metric } from '../../../lib/entities/aws-metrics-logger';
import { ApiInjector } from '../../../lib/handlers/base/api-handler';
import {
  ContainerInjected,
  HardQuoteHandler,
  HardQuoteRequestBody,
  RequestInjected,
} from '../../../lib/handlers/hard-quote';
import { OrderServiceProvider } from '../../../lib/providers/order';
import { MOCK_FILLER_ADDRESS, MockQuoter, Quoter } from '../../../lib/quoters';
import { MockPostedOrderRepository, PostedOrderOutcome } from '../../../lib/repositories/posted-order-repository';
import { ErrorCode } from '../../../lib/util/errors';
import { fakeContext, FakeCosigner, hardQuoteContainer } from '../../fakes';
import { getOrder } from '../../fixtures/hard-quote';

const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const CHAIN_ID = 1;

const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

// Status mapping when the order service post fails: only genuine 4xx
// rejections may surface as 400; indeterminate outcomes (timeouts, 5xx) must
// not, or clients treat a possibly-live order as rejected (SWAP-2839).
describe('Quote handler order post error mapping', () => {
  const swapperWallet = Wallet.createRandom();
  const cosignerWallet = Wallet.createRandom();

  const cosigner = new FakeCosigner(cosignerWallet);

  const fakes = fakeContext('test');

  afterEach(() => {
    // One ctx is shared across the describe; every test starts from empty recordings.
    fakes.metrics.reset();
    fakes.logger.reset();
  });

  const requestInjectedMock: Promise<RequestInjected> = new Promise(
    (resolve) =>
      resolve({
        log: logger,
        requestId: 'test',
        ctx: fakes.ctx,
      }) as unknown as RequestInjected
  );

  const injectorPromiseMock = (
    quoters: Quoter[],
    orderServiceProvider: OrderServiceProvider,
    postedOrderRepository: MockPostedOrderRepository
  ): Promise<ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>> =>
    new Promise((resolve) =>
      resolve({
        getContainerInjected: () =>
          hardQuoteContainer({
            quoters,
            orderServiceProvider,
            postedOrderRepository,
            cosignerFactory: cosigner.factory(),
          }),
        getRequestInjected: () => requestInjectedMock,
      } as unknown as ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>)
    );

  // MockQuoter at 2:1 beats the swapper's price, so the cosigned order carries an exclusive
  // filler and is eligible for PostedOrders bookkeeping; whether a row lands then depends
  // solely on the order-service outcome.
  const getQuoteHandler = (orderServiceProvider: OrderServiceProvider, repository: MockPostedOrderRepository) =>
    new HardQuoteHandler(
      'quote',
      injectorPromiseMock([new MockQuoter(logger, 2, 1)], orderServiceProvider, repository)
    );

  const getEvent = (request: HardQuoteRequestBody): APIGatewayProxyEvent =>
    ({
      body: JSON.stringify(request),
    } as APIGatewayProxyEvent);

  const getRequest = async (order: UnsignedV2DutchOrder): Promise<HardQuoteRequestBody> => {
    const { types, domain, values } = order.permitData();
    const sig = await swapperWallet._signTypedData(domain, types, values);
    return {
      requestId: REQUEST_ID,
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      encodedInnerOrder: order.serialize(),
      innerSig: sig,
    };
  };

  const postOrderWith = async (
    postResponse: {
      statusCode: number;
      errorCode?: ErrorCode;
      detail?: string;
      data?: unknown;
    },
    repository = new MockPostedOrderRepository()
  ): Promise<APIGatewayProxyResult> => {
    const orderServiceProvider = { postOrder: jest.fn().mockResolvedValue(postResponse) };
    const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));
    return await getQuoteHandler(orderServiceProvider, repository).handler(getEvent(request), {} as unknown as Context);
  };

  it('returns 200 when the order service accepts with 201', async () => {
    const response = await postOrderWith({ statusCode: 201, data: { hash: '0xhash' } });
    expect(response.statusCode).toEqual(200);
  });

  // 201 is also what a timed-out post reconciled as accepted returns, so this covers both
  // confirmed-post paths.
  it('records the posted order once the order service confirms it', async () => {
    const repository = new MockPostedOrderRepository();
    const response = await postOrderWith({ statusCode: 201, data: { hash: '0xhash' } }, repository);
    expect(response.statusCode).toEqual(200);
    const { orderHash } = JSON.parse(response.body);
    expect(repository.records.size).toEqual(1);
    expect(await repository.getPostedOrder(orderHash)).toMatchObject({
      orderHash,
      // the winning quote's id (what was sent to the order service); the request had none
      quoteId: expect.any(String),
      fillerAddress: MOCK_FILLER_ADDRESS,
      filler: 'https://uniswap.org',
      outcome: PostedOrderOutcome.PENDING,
    });
  });

  it('returns 400 when the order service genuinely rejects the order', async () => {
    const response = await postOrderWith({
      statusCode: 400,
      errorCode: ErrorCode.ValidationError,
      detail: 'Onchain validation failed: InsufficientFunds',
    });
    expect(response.statusCode).toEqual(400);
    expect(JSON.parse(response.body)).toMatchObject({
      detail: 'Onchain validation failed: InsufficientFunds',
    });
    // Counted as a rejection, not a confirmed post: no QUOTE_200 and no alarmed QUOTE_LATENCY.
    expect(fakes.metrics.names()).toEqual(expect.arrayContaining([Metric.QUOTE_POST_ATTEMPT, Metric.QUOTE_400]));
    expect(fakes.metrics.names()).not.toContain(Metric.QUOTE_200);
    expect(fakes.metrics.emitted(Metric.QUOTE_LATENCY)).toEqual(0);
  });

  it('counts a rejection as QUOTE_POST_ERROR unless the swapper was short of funds', async () => {
    await postOrderWith({ statusCode: 400, errorCode: ErrorCode.ValidationError, detail: 'rejected' });
    expect(fakes.metrics.calls.map((c) => [c.kind, c.name])).toEqual([
      ['count', Metric.QUOTE_REQUESTED],
      // getBestQuote's quote-count metric, now through the same ctx
      ['count', Metric.RFQ_COUNT_1],
      ['count', Metric.QUOTE_POST_ATTEMPT],
      ['count', Metric.QUOTE_POST_ERROR],
      ['count', Metric.QUOTE_400],
      ['timer', Metric.QUOTE_E2E_LATENCY],
    ]);

    fakes.metrics.reset();
    // A user error, not an alertable service error.
    await postOrderWith({
      statusCode: 400,
      errorCode: ErrorCode.ValidationError,
      detail: POST_ORDER_ERROR_REASON.INSUFFICIENT_FUNDS,
    });
    expect(fakes.metrics.emitted(Metric.QUOTE_POST_ERROR)).toEqual(0);
    expect(fakes.metrics.emitted(Metric.QUOTE_400)).toEqual(1);
  });

  it('counts an indeterminate outcome as QUOTE_POST_ERROR and QUOTE_500, and logs it at error level', async () => {
    await postOrderWith({
      statusCode: 500,
      errorCode: ErrorCode.InternalError,
      detail: 'timed out',
      data: { hash: '0xabc' },
    });
    expect(fakes.metrics.calls.map((c) => [c.kind, c.name])).toEqual([
      ['count', Metric.QUOTE_REQUESTED],
      // getBestQuote's quote-count metric, now through the same ctx
      ['count', Metric.RFQ_COUNT_1],
      ['count', Metric.QUOTE_POST_ATTEMPT],
      ['count', Metric.QUOTE_POST_ERROR],
      ['count', Metric.QUOTE_500],
      ['timer', Metric.QUOTE_E2E_LATENCY],
    ]);
    const [errorLog] = fakes.logger.atLevel('error');
    expect(errorLog.msg).toEqual('Error posting order');
    expect(errorLog.bindings).toEqual({ requestId: 'test' });
    expect(errorLog.fields.error).toMatchObject({ statusCode: 500, detail: 'timed out' });
  });

  it('records nothing when the order service rejects the order', async () => {
    const repository = new MockPostedOrderRepository();
    await postOrderWith({ statusCode: 400, errorCode: ErrorCode.ValidationError, detail: 'rejected' }, repository);
    expect(repository.records.size).toEqual(0);
  });

  it('records nothing when the order post outcome is indeterminate', async () => {
    const repository = new MockPostedOrderRepository();
    await postOrderWith(
      { statusCode: 500, errorCode: ErrorCode.InternalError, detail: 'timed out', data: { hash: '0xabc' } },
      repository
    );
    expect(repository.records.size).toEqual(0);
  });

  it('returns 500 with the order hash when the order post outcome is indeterminate', async () => {
    const response = await postOrderWith({
      statusCode: 500,
      errorCode: ErrorCode.InternalError,
      detail: 'Timed out posting order to UniswapX Service; order acceptance could not be confirmed',
      data: { hash: '0xabc' },
    });
    expect(response.statusCode).toEqual(500);
    // The hash must survive the handler spread + base-handler serialization so
    // the client can reconcile a possibly-live order (SWAP-2839). Same { hash }
    // shape as a success response.
    expect(JSON.parse(response.body)).toMatchObject({
      errorCode: ErrorCode.InternalError,
      data: { hash: '0xabc' },
    });
  });
});
