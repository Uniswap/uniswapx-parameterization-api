import { KMSClient } from '@aws-sdk/client-kms';
import { UnsignedV2DutchOrder, UnsignedV2DutchOrderInfo } from '@uniswap/uniswapx-sdk';
import { createMetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';
import { BigNumber, ethers, Wallet } from 'ethers';

import { AWSMetricsLogger } from '../../../lib/entities/aws-metrics-logger';
import { ApiInjector } from '../../../lib/handlers/base/api-handler';
import {
  ContainerInjected,
  HardQuoteHandler,
  HardQuoteRequestBody,
  RequestInjected,
} from '../../../lib/handlers/hard-quote';
import { OrderServiceProvider } from '../../../lib/providers/order';
import { MockQuoter, Quoter } from '../../../lib/quoters';
import { ErrorCode } from '../../../lib/util/errors';
import { KmsSigner } from '@uniswap/signer';

jest.mock('axios');
jest.mock('@aws-sdk/client-kms');
jest.mock('@uniswap/signer');

const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const RAW_AMOUNT = BigNumber.from('1000000000000000000');
const CHAIN_ID = 1;

const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

process.env.KMS_KEY_ID = 'test-key-id';
process.env.REGION = 'us-east-2';

const getOrder = (data: Partial<UnsignedV2DutchOrderInfo>): UnsignedV2DutchOrder => {
  const now = Math.floor(new Date().getTime() / 1000);
  return new UnsignedV2DutchOrder(
    Object.assign(
      {
        deadline: now + 1000,
        reactor: ethers.constants.AddressZero,
        swapper: ethers.constants.AddressZero,
        nonce: BigNumber.from(10),
        additionalValidationContract: ethers.constants.AddressZero,
        additionalValidationData: '0x',
        cosigner: ethers.constants.AddressZero,
        cosignerData: undefined,
        input: {
          token: TOKEN_IN,
          startAmount: RAW_AMOUNT,
          endAmount: RAW_AMOUNT,
        },
        outputs: [
          {
            token: TOKEN_OUT,
            startAmount: RAW_AMOUNT,
            endAmount: RAW_AMOUNT.mul(90).div(100),
            recipient: ethers.constants.AddressZero,
          },
        ],
        cosignature: undefined,
      },
      data
    ),
    CHAIN_ID
  );
};

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

  const requestInjectedMock: Promise<RequestInjected> = new Promise((resolve) =>
    resolve({
      log: logger,
      requestId: 'test',
      metric: new AWSMetricsLogger(createMetricsLogger()),
    }) as unknown as RequestInjected
  );

  const injectorPromiseMock = (
    quoters: Quoter[],
    orderServiceProvider: OrderServiceProvider
  ): Promise<ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>> =>
    new Promise((resolve) =>
      resolve({
        getContainerInjected: () => {
          return {
            quoters,
            orderServiceProvider,
            chainIdRpcMap: new Map([[42161, new ethers.providers.StaticJsonRpcProvider()]]),
          };
        },
        getRequestInjected: () => requestInjectedMock,
      } as unknown as ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>)
    );

  const getQuoteHandler = (orderServiceProvider: OrderServiceProvider) =>
    new HardQuoteHandler('quote', injectorPromiseMock([new MockQuoter(logger, 1, 1)], orderServiceProvider));

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

  const postOrderWith = async (postResponse: {
    statusCode: number;
    errorCode?: ErrorCode;
    detail?: string;
    data?: unknown;
  }): Promise<APIGatewayProxyResult> => {
    const orderServiceProvider = { postOrder: jest.fn().mockResolvedValue(postResponse) };
    const request = await getRequest(getOrder({ cosigner: cosignerWallet.address }));
    return await getQuoteHandler(orderServiceProvider).handler(getEvent(request), {} as unknown as Context);
  };

  it('returns 200 when the order service accepts with 201', async () => {
    const response = await postOrderWith({ statusCode: 201, data: { hash: '0xhash' } });
    expect(response.statusCode).toEqual(200);
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

  it('returns 500 when the order post outcome is indeterminate', async () => {
    const response = await postOrderWith({
      statusCode: 500,
      errorCode: ErrorCode.InternalError,
      detail: 'Timed out posting order to UniswapX Service and order was not found; status unknown',
    });
    expect(response.statusCode).toEqual(500);
    expect(JSON.parse(response.body)).toMatchObject({
      errorCode: ErrorCode.InternalError,
    });
  });
});
