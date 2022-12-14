import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';
import { ethers } from 'ethers';

import { ApiInjector, ApiRInj } from '../../../lib/handlers/base/api-handler';
import { ContainerInjected, PostQuoteRequestBody, PostQuoteResponse } from '../../../lib/handlers/quote';
import { QuoteHandler } from '../../../lib/handlers/quote/handler';
import { MockQuoter, Quoter } from '../../../lib/quoters';

const OFFERER = '0x0000000000000000000000000000000000000000';
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// silent logger in tests
const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

describe('Quote handler', () => {
  // Creating mocks for all the handler dependencies.
  const requestInjectedMock: Promise<ApiRInj> = new Promise(
    (resolve) =>
      resolve({
        log: logger,
        requestId: 'test',
      }) as unknown as ApiRInj
  );

  const injectorPromiseMock = (
    quoters: Quoter[]
  ): Promise<ApiInjector<ContainerInjected, ApiRInj, PostQuoteRequestBody, void>> =>
    new Promise((resolve) =>
      resolve({
        getContainerInjected: () => {
          return {
            quoters,
          };
        },
        getRequestInjected: () => requestInjectedMock,
      } as unknown as ApiInjector<ContainerInjected, ApiRInj, PostQuoteRequestBody, void>)
    );

  const getQuoteHandler = (quoters: Quoter[]) => new QuoteHandler('quote', injectorPromiseMock(quoters));

  const getEvent = (request: PostQuoteRequestBody): APIGatewayProxyEvent =>
    ({
      body: JSON.stringify(request),
    } as APIGatewayProxyEvent);

  const getRequest = (amountIn: string): PostQuoteRequestBody => ({
    offerer: OFFERER,
    tokenIn: TOKEN_IN,
    amountIn: amountIn,
    tokenOut: TOKEN_OUT,
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('Simple request and response', async () => {
    const quoters = [new MockQuoter(1, 1)];
    const amountIn = ethers.utils.parseEther('1');
    const request = getRequest(amountIn.toString());

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: PostQuoteResponse = JSON.parse(response.body);
    expect(response.statusCode).toEqual(200);
    expect(quoteResponse).toMatchObject({
      amountOut: amountIn.toString(),
      ...request,
    });
  });

  it('Handles hex amount', async () => {
    const quoters = [new MockQuoter(1, 1)];
    const amountIn = ethers.utils.parseEther('1');
    const request = getRequest(amountIn.toHexString());

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: PostQuoteResponse = JSON.parse(response.body);
    expect(response.statusCode).toEqual(200);
    expect(quoteResponse).toMatchObject({
      ...request,
      amountOut: amountIn.toString(),
      amountIn: amountIn.toString(),
    });
  });

  it('Pick the greater of two quotes', async () => {
    const quoters = [new MockQuoter(1, 1), new MockQuoter(2, 1)];
    const amountIn = ethers.utils.parseEther('1');
    const request = getRequest(amountIn.toString());

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: PostQuoteResponse = JSON.parse(response.body);
    expect(response.statusCode).toEqual(200);
    expect(quoteResponse).toMatchObject({
      amountOut: amountIn.mul(2).toString(),
      ...request,
    });
  });

  it('Two quoters returning the same result', async () => {
    const quoters = [new MockQuoter(1, 1), new MockQuoter(1, 1)];
    const amountIn = ethers.utils.parseEther('1');
    const request = getRequest(amountIn.toString());

    const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
      getEvent(request),
      {} as unknown as Context
    );
    const quoteResponse: PostQuoteResponse = JSON.parse(response.body);
    expect(response.statusCode).toEqual(200);
    expect(quoteResponse).toMatchObject({
      amountOut: amountIn.toString(),
      ...request,
    });
  });

  it('Invalid amountIn', async () => {
    const invalidAmounts = ['-100', 'aszzz', 'zz'];

    const quoters = [new MockQuoter(1, 1)];

    for (const amount of invalidAmounts) {
      const request = getRequest(amount);

      const response: APIGatewayProxyResult = await getQuoteHandler(quoters).handler(
        getEvent(request),
        {} as unknown as Context
      );
      const error = JSON.parse(response.body);
      expect(response.statusCode).toEqual(400);
      expect(error).toMatchObject({
        detail: 'Invalid amount',
        errorCode: 'VALIDATION_ERROR',
      });
    }
  });
});
