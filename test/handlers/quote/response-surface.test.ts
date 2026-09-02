import { createMetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';
import { ethers } from 'ethers';

import { AWSMetricsLogger } from '../../../lib/entities/aws-metrics-logger';
import { ApiInjector } from '../../../lib/handlers/base/api-handler';
import { ContainerInjected, PostQuoteRequestBody, RequestInjected } from '../../../lib/handlers/quote';
import { QuoteHandler } from '../../../lib/handlers/quote/handler';
import { ProtocolVersion } from '../../../lib/providers';
import { MockQuoter, Quoter } from '../../../lib/quoters';

/**
 * Response-surface snapshots for POST /quote.
 *
 * These pin the exact JSON the Trading API sees -- status code, CORS headers, success body
 * (best quote fanned out at the top level plus `allQuotes`), and every error body shape the
 * handler can produce -- so a refactor that changes any of it fails loudly here.
 *
 * Everything is captured AS-IS. Where a snapshot pins something that looks like a defect,
 * the test comment says so; do not "fix" it from this file.
 */

// MockQuoter mints a fresh quoteId per quote via uuid.v4(). Pin it so the 200 snapshots are
// byte-stable, but keep each quote's id distinct so a fan-out regression (e.g. every entry in
// allQuotes echoing the best quote's id) still shows up in the snapshot.
jest.mock('uuid', () => {
  let n = 0;
  return {
    v4: () => `${String(++n).padStart(8, '0')}-0000-4000-8000-000000000000`,
    __resetCounter: () => {
      n = 0;
    },
  };
});

const REQUEST_ID = 'b45c2d1e-7f30-4a92-8c65-1d8e4f2a9b03';
const SWAPPER = '0x0000000000000000000000000000000000000000';
const TOKEN_IN = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const TOKEN_OUT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CHAIN_ID = 1;
const ONE_ETHER = ethers.utils.parseEther('1').toString();

const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

describe('/quote response surface', () => {
  const requestInjectedMock: Promise<RequestInjected> = new Promise(
    (resolve) =>
      resolve({
        log: logger,
        // Surfaces as the `id` field of every handler-level error body below.
        requestId: 'test',
        metric: new AWSMetricsLogger(createMetricsLogger()),
      }) as unknown as RequestInjected
  );

  const injectorPromiseMock = (
    quoters: Quoter[]
  ): Promise<ApiInjector<ContainerInjected, RequestInjected, PostQuoteRequestBody, void>> =>
    new Promise((resolve) =>
      resolve({
        getContainerInjected: () => ({
          quoters,
          chainIdRpcMap: new Map([[42161, new ethers.providers.StaticJsonRpcProvider()]]),
        }),
        getRequestInjected: () => requestInjectedMock,
      } as unknown as ApiInjector<ContainerInjected, RequestInjected, PostQuoteRequestBody, void>)
    );

  const validRequest = (overrides: Partial<PostQuoteRequestBody> = {}): PostQuoteRequestBody => ({
    requestId: REQUEST_ID,
    tokenInChainId: CHAIN_ID,
    tokenOutChainId: CHAIN_ID,
    swapper: SWAPPER,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amount: ONE_ETHER,
    type: 'EXACT_INPUT',
    numOutputs: 1,
    protocol: ProtocolVersion.V2,
    ...overrides,
  });

  /**
   * Invokes the full Lambda entrypoint (the `handler` getter, not `handleRequest`) so the
   * snapshot covers everything API Gateway forwards: status, headers, and the serialized body.
   * `rawBody` is kept alongside the parsed body because pretty-format sorts object keys, so
   * the parsed view alone would not catch a change in key order or whitespace.
   */
  const invoke = async (quoters: Quoter[], body: string | undefined) => {
    const handler = new QuoteHandler('quote', injectorPromiseMock(quoters));
    const response = await handler.handler({ body } as APIGatewayProxyEvent, {} as unknown as Context);
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: JSON.parse(response.body),
      rawBody: response.body,
    };
  };

  beforeEach(() => {
    jest.requireMock('uuid').__resetCounter();
  });

  describe('200', () => {
    it('EXACT_INPUT: best quote fanned out at the top level, every quote under allQuotes', async () => {
      // 1:1 and 2:1 quoters; the 2x amountOut wins and is echoed at the top level.
      const quoters = [new MockQuoter(logger, 1, 1), new MockQuoter(logger, 2, 1)];
      const result = await invoke(quoters, JSON.stringify(validRequest()));
      expect(result.statusCode).toEqual(200);
      expect(result).toMatchSnapshot();
    });

    it('EXACT_OUTPUT: lowest amountIn wins', async () => {
      const quoters = [new MockQuoter(logger, 1, 1), new MockQuoter(logger, 2, 1)];
      const result = await invoke(quoters, JSON.stringify(validRequest({ type: 'EXACT_OUTPUT' })));
      expect(result.statusCode).toEqual(200);
      expect(result).toMatchSnapshot();
    });

    it('single quoter: allQuotes is still present with one entry', async () => {
      const result = await invoke([new MockQuoter(logger, 1, 1)], JSON.stringify(validRequest()));
      expect(result.statusCode).toEqual(200);
      expect(result).toMatchSnapshot();
    });

    it('protocol defaults to V1 when omitted and the response shape is unchanged', async () => {
      const withoutProtocol = (({ protocol: _p, ...rest }) => rest)(validRequest());
      const result = await invoke([new MockQuoter(logger, 1, 1)], JSON.stringify(withoutProtocol));
      expect(result.statusCode).toEqual(200);
      expect(result).toMatchSnapshot();
    });
  });

  describe('404 NoQuotesAvailable', () => {
    it('no quoters configured', async () => {
      const result = await invoke([], JSON.stringify(validRequest()));
      expect(result.statusCode).toEqual(404);
      expect(result).toMatchSnapshot();
    });
  });

  describe('400 request validation (Joi)', () => {
    // Joi runs with abortEarly (the default), so each body reports only its first violation.
    it.each<[string, Record<string, unknown>]>([
      ['non-numeric amount', validRequest({ amount: 'abc' })],
      ['negative amount', validRequest({ amount: '-1' })],
      ['missing requestId', (({ requestId: _r, ...rest }) => rest)(validRequest())],
      ['non-uuid requestId', validRequest({ requestId: '1234' })],
      ['tokenOutChainId differs from tokenInChainId', validRequest({ tokenOutChainId: 10 })],
      ['unsupported chainId', validRequest({ tokenInChainId: 999999, tokenOutChainId: 999999 })],
      ['invalid swapper address', validRequest({ swapper: '0xnotanaddress' })],
      ['invalid tradeType', validRequest({ type: 'EXACT_NEITHER' })],
      ['numOutputs below 1', validRequest({ numOutputs: 0 })],
      ['unknown protocol', validRequest({ protocol: 'v9' as ProtocolVersion })],
      ['empty object', {}],
    ])('%s', async (_name, body) => {
      const result = await invoke([new MockQuoter(logger, 1, 1)], JSON.stringify(body));
      expect(result.statusCode).toEqual(400);
      // Validation errors are produced before the request injector runs, so unlike the
      // handler-level errors above they carry no `id` field.
      expect(result.body).not.toHaveProperty('id');
      expect(result).toMatchSnapshot();
    });

    it('unknown fields are stripped rather than rejected', async () => {
      const result = await invoke(
        [new MockQuoter(logger, 1, 1)],
        JSON.stringify({ ...validRequest(), extraField: 'ignored' })
      );
      expect(result.statusCode).toEqual(200);
      expect(result.body).not.toHaveProperty('extraField');
    });
  });

  describe('malformed transport', () => {
    it('422 on a body that is not JSON', async () => {
      const result = await invoke([new MockQuoter(logger, 1, 1)], '{not json');
      expect(result.statusCode).toEqual(422);
      expect(result).toMatchSnapshot();
    });

    it('500 INTERNAL_ERROR on a missing body (captured as-is; arguably should be a 4xx)', async () => {
      // With no body the base handler skips validation entirely and hands `undefined` to the
      // handler, which then dereferences it. With the real request injector this trips one
      // step earlier (buildQuoteRequestInjected reads requestBody.tokenInChainId) and yields
      // the same body without `id`; the mocked injector here lets it reach handleRequest.
      const result = await invoke([new MockQuoter(logger, 1, 1)], undefined);
      expect(result.statusCode).toEqual(500);
      expect(result).toMatchSnapshot();
    });
  });
});
