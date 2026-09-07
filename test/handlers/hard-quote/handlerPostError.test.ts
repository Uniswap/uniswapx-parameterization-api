import { KMSClient } from '@aws-sdk/client-kms';
import { UnsignedV2DutchOrder } from '@uniswap/uniswapx-sdk';
import { createMetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';
import { ethers, Wallet } from 'ethers';

import { KmsSigner } from '@uniswap/signer';
import { AWSMetricsLogger } from '../../../lib/entities/aws-metrics-logger';
import { ApiInjector } from '../../../lib/handlers/base/api-handler';
import {
  ContainerInjected,
  HardQuoteHandler,
  HardQuoteRequestBody,
  RequestInjected,
} from '../../../lib/handlers/hard-quote';
import { OrderServiceProvider } from '../../../lib/providers/order';
import { MOCK_FILLER_ADDRESS, MockQuoter, Quoter } from '../../../lib/quoters';
import { MockFillerAddressRepository } from '../../../lib/repositories/filler-address-repository';
import { MockPostedOrderRepository, PostedOrderOutcome } from '../../../lib/repositories/posted-order-repository';
import { ErrorCode } from '../../../lib/util/errors';
import { getOrder } from '../../fixtures/hard-quote';

jest.mock('axios');
jest.mock('@aws-sdk/client-kms');
jest.mock('@uniswap/signer');

const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const CHAIN_ID = 1;

const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

process.env.KMS_KEY_ID = 'test-key-id';
process.env.REGION = 'us-east-2';

// Status mapping when the order service post fails: only genuine 4xx
// rejections may surface as 400; indeterminate outcomes (timeouts, 5xx) must
// not, or clients treat a possibly-live order as rejected (SWAP-2839).
describe('Quote handler order post error mapping', () => {
  const swapperWallet = Wallet.createRandom();
  const cosignerWallet = Wallet.createRandom();

  const mockGetAddress = jest.fn().mockResolvedValue(cosignerWallet.address);
  const mockSignDigest = jest
    .fn()
    .mockImplementation((digest) => cosignerWallet.signMessage(ethers.utils.arrayify(digest)));

  (KmsSigner as jest.Mock).mockImplementation(() => ({
    getAddress: mockGetAddress,
    signDigest: mockSignDigest,
  }));
  (KMSClient as jest.Mock).mockImplementation(() => jest.fn());

  const requestInjectedMock: Promise<RequestInjected> = new Promise(
    (resolve) =>
      resolve({
        log: logger,
        requestId: 'test',
        metric: new AWSMetricsLogger(createMetricsLogger()),
      }) as unknown as RequestInjected
  );

  const injectorPromiseMock = (
    quoters: Quoter[],
    orderServiceProvider: OrderServiceProvider,
    postedOrderRepository: MockPostedOrderRepository
  ): Promise<ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>> =>
    new Promise((resolve) =>
      resolve({
        getContainerInjected: () => {
          return {
            quoters,
            orderServiceProvider,
            postedOrderRepository,
            fillerAddressRepository: new MockFillerAddressRepository(),
            chainIdRpcMap: new Map([[42161, new ethers.providers.StaticJsonRpcProvider()]]),
          };
        },
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
