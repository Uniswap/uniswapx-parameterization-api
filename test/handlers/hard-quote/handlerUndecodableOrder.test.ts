import { UniswapXOrderParser } from '@uniswap/uniswapx-sdk';
import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';
import { Wallet } from 'ethers';

import { CosignerFactory } from '../../../lib/core/cosigner';
import { Metric } from '../../../lib/entities';
import { ApiInjector } from '../../../lib/handlers/base/api-handler';
import {
  ContainerInjected,
  HardQuoteHandler,
  HardQuoteRequestBody,
  RequestInjected,
} from '../../../lib/handlers/hard-quote';
import { MockQuoter } from '../../../lib/quoters';
import { MalformedOrderError, UnsupportedOrderTypeError } from '../../../lib/util/errors';
import { fakeContext, FakeCosigner, hardQuoteContainer } from '../../fakes';
import { CHAIN_ID, getOrder } from '../../fixtures/hard-quote';

const REQUEST_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const QUOTE_ID = '5c8b4c1f-6c38-4b1a-9bd3-8c6f2c3b6d9e';
const ID = 'test';
// A reactor address no SDK reactor mapping knows.
const UNMAPPED_REACTOR = '0x000000000000000000000000000000000000b274';

// Orders the hard-quote decode step cannot use. Each used to fail inside the flow with an SDK or
// TypeError and answer the generic 500; each is a client error, so each answers a 400 that says
// what is wrong with encodedInnerOrder.
describe('Quote handler: undecodable orders', () => {
  const swapperWallet = Wallet.createRandom();
  const cosignerWallet = Wallet.createRandom();
  const validOrder = () => getOrder({ cosigner: cosignerWallet.address });

  let putMetric: jest.SpyInstance;
  let logRecords: { level: number; msg: string }[];

  beforeEach(() => {
    putMetric = jest.spyOn(MetricsLogger.prototype, 'putMetric');
    logRecords = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // The base handler logs and counts through the request's bunyan logger and the EMF logger; the
  // log records are captured to check the level each outcome is logged at.
  const handlerWith = (cosignerFactory: CosignerFactory): HardQuoteHandler => {
    const log = Logger.createLogger({
      name: 'test',
      streams: [{ type: 'raw', level: 'trace', stream: { write: (r: object) => logRecords.push(r as never) } }],
    });
    const requestInjected = { log, requestId: ID, ctx: fakeContext(ID).ctx } as unknown as RequestInjected;
    const injector = {
      getContainerInjected: () => hardQuoteContainer({ quoters: [new MockQuoter(log, 1, 1)], cosignerFactory }),
      getRequestInjected: async () => requestInjected,
    } as unknown as ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>;
    return new HardQuoteHandler('quote', Promise.resolve(injector));
  };

  const post = (body: HardQuoteRequestBody, cosignerFactory = new FakeCosigner(cosignerWallet).factory()) =>
    handlerWith(cosignerFactory).handler(
      { body: JSON.stringify(body) } as APIGatewayProxyEvent,
      {} as unknown as Context
    ) as Promise<APIGatewayProxyResult>;

  const requestFor = async (
    order = validOrder(),
    encodedInnerOrder = order.serialize()
  ): Promise<HardQuoteRequestBody> => {
    const { types, domain, values } = order.permitData();
    return {
      requestId: REQUEST_ID,
      quoteId: QUOTE_ID,
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      encodedInnerOrder,
      innerSig: await swapperWallet._signTypedData(domain, types, values),
    };
  };

  const counted = (metric: Metric) => putMetric.mock.calls.filter(([name]) => name === metric).length;
  const loggedAt = (msg: string) => logRecords.filter((r) => r.msg === msg).map((r) => Logger.nameFromLevel[r.level]);

  const expectClientError = (response: APIGatewayProxyResult, detail: string) => {
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(JSON.stringify({ errorCode: 'VALIDATION_ERROR', detail, id: ID }));
    expect(counted(Metric.QUOTE_400)).toBe(1);
    expect(counted(Metric.QUOTE_500)).toBe(0);
    expect(loggedAt('Client validation error')).toEqual(['info']);
    expect(loggedAt('Unexpected error in handler')).toEqual([]);
  };

  it.each([
    // The SDK reads the reactor from bytes that are too short or not hex as an empty address and
    // throws "invalid address" (the 2026-11-24 production case).
    ['empty bytes, whose reactor reads as an empty address', () => '0x'],
    ['non-hex text', () => 'not an order'],
    ['hex bytes that are not an order', () => `0x${'de'.repeat(480)}`],
    [
      'a V2 order cut off partway through',
      () =>
        validOrder()
          .serialize()
          .slice(0, 2 + 2 * 512),
    ],
  ])('answers 400 VALIDATION_ERROR for %s', async (_name, encodedInnerOrder) => {
    const response = await post(await requestFor(validOrder(), encodedInnerOrder()));

    expectClientError(response, MalformedOrderError.MESSAGE);
  });

  // outputs[0] is read by every later step, so this used to be a TypeError (a 500).
  it('answers 400 VALIDATION_ERROR for an order with no outputs', async () => {
    const order = getOrder({ cosigner: cosignerWallet.address, outputs: [] });

    const response = await post(await requestFor(order));

    expectClientError(response, MalformedOrderError.NO_OUTPUTS_MESSAGE);
  });

  it('answers 400 VALIDATION_ERROR for an order whose reactor the SDK has no order type for', async () => {
    const order = getOrder({ cosigner: cosignerWallet.address, reactor: UNMAPPED_REACTOR });

    const response = await post(await requestFor(order));

    expectClientError(response, UnsupportedOrderTypeError.MESSAGE);
  });

  it('still cosigns and answers 200 for a well-formed order', async () => {
    const response = await post(await requestFor());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ quoteId: QUOTE_ID, chainId: CHAIN_ID });
    expect(counted(Metric.QUOTE_400)).toBe(0);
    expect(counted(Metric.QUOTE_500)).toBe(0);
  });

  // The decode refusal is narrow: a failure after the decode step is still the generic 500.
  it('still answers the generic 500 for an error that is not a decode failure', async () => {
    const failingCosigner: CosignerFactory = () => ({
      getAddress: async () => {
        throw new Error('KMS unavailable');
      },
      signDigest: async () => '0x',
    });

    const response = await post(await requestFor(), failingCosigner);

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ errorCode: 'INTERNAL_ERROR', detail: 'Unexpected error', id: ID });
    expect(counted(Metric.QUOTE_500)).toBe(1);
    expect(counted(Metric.QUOTE_400)).toBe(0);
    expect(loggedAt('Unexpected error in handler')).toEqual(['error']);
  });

  // The cosigner case above fails after the decode step returns. This one fails inside it, so it
  // proves the decode catch maps only decode errors to a 400.
  it('still answers the generic 500 when the decode step throws an error that is not a decode failure', async () => {
    jest.spyOn(UniswapXOrderParser.prototype, 'getOrderTypeFromEncoded').mockImplementation(() => {
      throw new TypeError('unexpected parser bug');
    });

    const response = await post(await requestFor());

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ errorCode: 'INTERNAL_ERROR', detail: 'Unexpected error', id: ID });
    expect(counted(Metric.QUOTE_500)).toBe(1);
    expect(counted(Metric.QUOTE_400)).toBe(0);
    expect(loggedAt('Unexpected error in handler')).toEqual(['error']);
  });

  it('never echoes the encoded order back', async () => {
    const encodedInnerOrder = validOrder()
      .serialize()
      .slice(0, 2 + 2 * 512);

    const response = await post(await requestFor(validOrder(), encodedInnerOrder));

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(encodedInnerOrder.slice(2, 66));
  });
});
