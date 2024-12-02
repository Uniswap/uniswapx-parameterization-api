import { KMSClient } from '@aws-sdk/client-kms';
import { KmsSigner } from '@uniswap/signer';
import { USDT_ARBITRUM, WBTC_ARBITRUM } from '@uniswap/smart-order-router';
import {
  CosignedV3DutchOrder,
  UnsignedV3DutchOrder,
  UnsignedV3DutchOrderInfo,
  V3DutchOrderBuilder,
} from '@uniswap/uniswapx-sdk';
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
  HardQuoteResponseData,
  RequestInjected,
} from '../../../lib/handlers/hard-quote';
import { MockOrderServiceProvider } from '../../../lib/providers';
import { MockQuoter, Quoter } from '../../../lib/quoters';

jest.mock('axios');
jest.mock('@aws-sdk/client-kms');
jest.mock('@uniswap/signer');

//const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const TOKEN_IN = USDT_ARBITRUM;
const TOKEN_OUT = WBTC_ARBITRUM;
const RAW_AMOUNT = BigNumber.from('1000000000000000000');
const CHAIN_ID = 42161;

const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

process.env.KMS_KEY_ID = 'test-key-id';
process.env.REGION = 'us-east-2';

export const getPartialOrder = (data: Partial<UnsignedV3DutchOrderInfo>): UnsignedV3DutchOrder => {
  const now = Math.floor(new Date().getTime() / 1000);
  const validPartialOrder = new V3DutchOrderBuilder(CHAIN_ID)
    .cosigner(data.cosigner ?? ethers.constants.AddressZero)
    .deadline(now + 1000)
    .swapper(ethers.constants.AddressZero)
    .nonce(BigNumber.from(100))
    .startingBaseFee(BigNumber.from(0))
    .input({
      token: TOKEN_IN.address,
      startAmount: RAW_AMOUNT,
      curve: {
        relativeBlocks: [],
        relativeAmounts: [],
      },
      maxAmount: RAW_AMOUNT,
      adjustmentPerGweiBaseFee: BigNumber.from(0),
    })
    .output({
      token: TOKEN_OUT.address,
      startAmount: RAW_AMOUNT,
      curve: {
        relativeBlocks: [4],
        relativeAmounts: [BigInt(4)],
      },
      recipient: ethers.constants.AddressZero,
      minAmount: RAW_AMOUNT.sub(4),
      adjustmentPerGweiBaseFee: BigNumber.from(0),
    })

    .buildPartial();

  return validPartialOrder;
};

describe('Quote handler', () => {
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

  // Creating mocks for all the handler dependencies.
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
            // Mock chainIdRpcMap
            chainIdRpcMap: new Map([
              [42161, new ethers.providers.StaticJsonRpcProvider()],
            ]),
          };
        },
        getRequestInjected: () => requestInjectedMock,
      } as unknown as ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>)
    );

  const getQuoteHandler = (quoters: Quoter[]) => new HardQuoteHandler('quote', injectorPromiseMock(quoters));

  const getEvent = (request: HardQuoteRequestBody): APIGatewayProxyEvent =>
    ({
      body: JSON.stringify(request),
    } as APIGatewayProxyEvent);

  const getRequest = async (order: UnsignedV3DutchOrder): Promise<HardQuoteRequestBody> => {
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

  afterEach(() => {
    jest.clearAllMocks();
  });

  it.skip('Simple request and response', async () => {
    // Skip until V3 Order Service is ready
    const quoters = [new MockQuoter(logger, 1, 1)];
    const request = await getRequest(getPartialOrder({ cosigner: cosignerWallet.address }));

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: HardQuoteResponseData = JSON.parse(response.body); // random quoteId
    expect(response.statusCode).toEqual(200);
    expect(quoteResponse.requestId).toEqual(request.requestId);
    expect(quoteResponse.quoteId).toEqual(request.quoteId);
    expect(quoteResponse.chainId).toEqual(request.tokenInChainId);
    expect(quoteResponse.filler).toEqual(ethers.constants.AddressZero);
    const cosignedOrder = CosignedV3DutchOrder.parse(quoteResponse.encodedOrder, CHAIN_ID);

    // no overrides since quote was same as request
    expect(cosignedOrder.info.cosignerData.exclusiveFiller).toEqual(ethers.constants.AddressZero);
    expect(cosignedOrder.info.cosignerData.inputOverride).toEqual(BigNumber.from(0));
    expect(cosignedOrder.info.cosignerData.outputOverrides.length).toEqual(1);
    expect(cosignedOrder.info.cosignerData.outputOverrides[0]).toEqual(BigNumber.from(0));
  });
});
