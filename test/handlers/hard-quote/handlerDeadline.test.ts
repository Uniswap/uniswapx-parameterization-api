import { KMSClient } from '@aws-sdk/client-kms';
import { UnsignedV2DutchOrder, UnsignedV2DutchOrderInfo } from '@uniswap/uniswapx-sdk';
import { KmsSigner } from '@uniswap/signer';
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
import { MockOrderServiceProvider } from '../../../lib/providers';
import { MockQuoter, Quoter } from '../../../lib/quoters';

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

describe('Hard quote handler - order deadline validation', () => {
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
    quoters: Quoter[]
  ): Promise<ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>> =>
    new Promise((resolve) =>
      resolve({
        getContainerInjected: () => {
          return {
            quoters,
            orderServiceProvider: new MockOrderServiceProvider(),
            chainIdRpcMap: new Map([[42161, new ethers.providers.StaticJsonRpcProvider()]]),
          };
        },
        getRequestInjected: () => requestInjectedMock,
      } as unknown as ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>)
    );

  const getHandler = (quoters: Quoter[]) => new HardQuoteHandler('quote', injectorPromiseMock(quoters));

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
    } as HardQuoteRequestBody;
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Regression test for EXE-28: a deadline that is too close (or already in the
  // past) for the decay window to complete must return a final, non-retryable
  // 400 rather than an unhandled 5xx that prompts the customer to retry.
  it('returns a 400 (not a retryable 5xx) when the deadline is too close for the decay window - RFQ path', async () => {
    const quoters = [new MockQuoter(logger, 1, 1)];
    const now = Math.floor(Date.now() / 1000);
    // On mainnet the decay window ends ~84s after now (decayStartTime now+24,
    // decayEndTime +60), so a deadline a few seconds out can never fit it.
    const request = await getRequest(getOrder({ cosigner: cosignerWallet.address, deadline: now + 5 }));

    const response: APIGatewayProxyResult = await getHandler(quoters).handler(getEvent(request), {} as Context);

    expect(response.statusCode).toEqual(400);
    const error = JSON.parse(response.body);
    expect(error.errorCode).toEqual('VALIDATION_ERROR');
    expect(error.detail).toContain('deadline');
  });

  it('returns a 400 when the deadline is too close - open order (no quote) path', async () => {
    const now = Math.floor(Date.now() / 1000);
    const request = await getRequest(getOrder({ cosigner: cosignerWallet.address, deadline: now + 5 }));

    // No quoters -> open order path with allowNoQuote so we reach default cosigner data.
    const response: APIGatewayProxyResult = await getHandler([]).handler(
      getEvent({ ...request, allowNoQuote: true }),
      {} as Context
    );

    expect(response.statusCode).toEqual(400);
    const error = JSON.parse(response.body);
    expect(error.errorCode).toEqual('VALIDATION_ERROR');
    expect(error.detail).toContain('deadline');
  });

  it('still succeeds when the deadline comfortably exceeds the decay window', async () => {
    const quoters = [new MockQuoter(logger, 1, 1)];
    const request = await getRequest(getOrder({ cosigner: cosignerWallet.address, deadline: Math.floor(Date.now() / 1000) + 1000 }));

    const response: APIGatewayProxyResult = await getHandler(quoters).handler(getEvent(request), {} as Context);

    expect(response.statusCode).toEqual(200);
  });
});
