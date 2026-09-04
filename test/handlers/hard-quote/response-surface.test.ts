import { KMSClient } from '@aws-sdk/client-kms';
import { KmsSigner } from '@uniswap/signer';
import { CosignedV2DutchOrder, UnsignedV2DutchOrder } from '@uniswap/uniswapx-sdk';
import { createMetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';
import { ethers, Wallet } from 'ethers';

import { AWSMetricsLogger } from '../../../lib/entities/aws-metrics-logger';
import { ApiInjector } from '../../../lib/handlers/base/api-handler';
import {
  ContainerInjected,
  HardQuoteHandler,
  HardQuoteRequestBody,
  RequestInjected,
} from '../../../lib/handlers/hard-quote';
import { MockOrderServiceProvider } from '../../../lib/providers';
import { OrderServiceProvider } from '../../../lib/providers/order';
import { MockQuoter, Quoter } from '../../../lib/quoters';
import { ErrorCode } from '../../../lib/util/errors';
import { CHAIN_ID, getOrder } from '../../fixtures/hard-quote';

/**
 * Response-surface snapshots for POST /hard-quote.
 *
 * Pins the exact JSON the Trading API sees: the cosigned-order success body, every
 * order-service post-failure shape, and the request-validation error bodies. Captured AS-IS;
 * comments call out anything that looks like a defect rather than fixing it here.
 *
 * DETERMINISM: `encodedOrder` and `orderHash` are ABI encodings of the cosigned order, so
 * they are byte-stable only if every input is. Wallets come from fixed private keys (ethers
 * signs with RFC 6979, so signatures are deterministic), `Date.now` is pinned (the cosigner's
 * decay window is derived from it), and the fixture's clock-derived `deadline` is overridden
 * with a value relative to the pinned clock.
 */

jest.mock('axios');
jest.mock('@aws-sdk/client-kms');
jest.mock('@uniswap/signer');

const FIXED_NOW_MS = 1_756_800_000_000; // 2025-09-02T08:00:00.000Z
const FIXED_NOW_S = FIXED_NOW_MS / 1000;
// Deliberately distinct: the response echoes quoteId AS requestId (see requestid-invariant),
// so aliasing the two would make that behavior invisible in the snapshot.
const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const REQUEST_ID = 'b45c2d1e-7f30-4a92-8c65-1d8e4f2a9b03';

const swapperWallet = new Wallet(`0x${'11'.repeat(32)}`);
const cosignerWallet = new Wallet(`0x${'22'.repeat(32)}`);

const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

process.env.KMS_KEY_ID = 'test-key-id';
process.env.REGION = 'us-east-2';

describe('/hard-quote response surface', () => {
  let dateNowSpy: jest.SpyInstance;

  beforeEach(() => {
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS);
    (KmsSigner as jest.Mock).mockImplementation(() => ({
      getAddress: jest.fn().mockResolvedValue(cosignerWallet.address),
      signDigest: jest
        .fn()
        .mockImplementation((digest: string) => cosignerWallet.signMessage(ethers.utils.arrayify(digest))),
    }));
    (KMSClient as jest.Mock).mockImplementation(() => jest.fn());
  });

  afterEach(() => {
    // Not restoreAllMocks(): on jest 29 that also wipes the KmsSigner mockImplementation.
    dateNowSpy.mockRestore();
    jest.clearAllMocks();
  });

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
    quoters: Quoter[],
    orderServiceProvider: OrderServiceProvider
  ): Promise<ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>> =>
    new Promise((resolve) =>
      resolve({
        getContainerInjected: () => ({
          quoters,
          orderServiceProvider,
          chainIdRpcMap: new Map([[42161, new ethers.providers.StaticJsonRpcProvider()]]),
        }),
        getRequestInjected: () => requestInjectedMock,
      } as unknown as ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>)
    );

  const fixedOrder = (overrides: Parameters<typeof getOrder>[0] = {}): UnsignedV2DutchOrder =>
    getOrder({
      cosigner: cosignerWallet.address,
      swapper: swapperWallet.address,
      deadline: FIXED_NOW_S + 1000,
      ...overrides,
    });

  const signedRequest = async (
    order: UnsignedV2DutchOrder,
    overrides: Partial<HardQuoteRequestBody> = {}
  ): Promise<HardQuoteRequestBody> => {
    const { types, domain, values } = order.permitData();
    const innerSig = await swapperWallet._signTypedData(domain, types, values);
    return {
      requestId: REQUEST_ID,
      quoteId: QUOTE_ID,
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      encodedInnerOrder: order.serialize(),
      innerSig,
      ...overrides,
    };
  };

  /**
   * Invokes the full Lambda entrypoint so the snapshot covers status, headers, and the
   * serialized body. `rawBody` pins key order and whitespace, which the parsed view loses
   * because pretty-format sorts keys.
   */
  const invoke = async (quoters: Quoter[], orderServiceProvider: OrderServiceProvider, body: string | undefined) => {
    const handler = new HardQuoteHandler('hardQuote', injectorPromiseMock(quoters, orderServiceProvider));
    const response = await handler.handler({ body } as APIGatewayProxyEvent, {} as unknown as Context);
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: JSON.parse(response.body),
      rawBody: response.body,
    };
  };

  /** Human-readable view of what the opaque `encodedOrder` hex carries, for reviewers. */
  const decodeCosignerData = (encodedOrder: string) => {
    const { cosignerData } = CosignedV2DutchOrder.parse(encodedOrder, CHAIN_ID).info;
    return {
      decayStartTime: cosignerData.decayStartTime,
      decayEndTime: cosignerData.decayEndTime,
      exclusiveFiller: cosignerData.exclusiveFiller,
      exclusivityOverrideBps: cosignerData.exclusivityOverrideBps.toString(),
      inputOverride: cosignerData.inputOverride.toString(),
      outputOverrides: cosignerData.outputOverrides.map((o) => o.toString()),
    };
  };

  describe('200', () => {
    it('quote equal to the order: no overrides, AddressZero filler', async () => {
      const request = await signedRequest(fixedOrder());
      const result = await invoke(
        [new MockQuoter(logger, 1, 1)],
        new MockOrderServiceProvider(),
        JSON.stringify(request)
      );
      expect(result.statusCode).toEqual(200);
      expect({ ...result, decodedCosignerData: decodeCosignerData(result.body.encodedOrder) }).toMatchSnapshot();
    });

    it('quote better than the order: exclusive filler and output override in the encoded order', async () => {
      const request = await signedRequest(fixedOrder());
      const quoters = [new MockQuoter(logger, 1, 1), new MockQuoter(logger, 2, 1)];
      const result = await invoke(quoters, new MockOrderServiceProvider(), JSON.stringify(request));
      expect(result.statusCode).toEqual(200);
      expect({ ...result, decodedCosignerData: decodeCosignerData(result.body.encodedOrder) }).toMatchSnapshot();
    });

    it('order service 201 is surfaced as 200 with the same body shape', async () => {
      const request = await signedRequest(fixedOrder());
      const orderService = { postOrder: jest.fn().mockResolvedValue({ statusCode: 201, data: { hash: '0xhash' } }) };
      const result = await invoke([new MockQuoter(logger, 1, 1)], orderService, JSON.stringify(request));
      expect(result.statusCode).toEqual(200);
      expect(result).toMatchSnapshot();
    });
  });

  describe('order service post failures', () => {
    const postOrderWith = async (postResponse: {
      statusCode: number;
      errorCode?: ErrorCode;
      detail?: string;
      data?: unknown;
    }) => {
      const request = await signedRequest(fixedOrder());
      const orderService = { postOrder: jest.fn().mockResolvedValue(postResponse) };
      return invoke([new MockQuoter(logger, 1, 1)], orderService, JSON.stringify(request));
    };

    it('4xx rejection is mapped to 400 and the order service detail/errorCode are passed through', async () => {
      const result = await postOrderWith({
        statusCode: 400,
        errorCode: ErrorCode.ValidationError,
        detail: 'Onchain validation failed: InsufficientFunds',
      });
      expect(result.statusCode).toEqual(400);
      expect(result).toMatchSnapshot();
    });

    it('any other 4xx (e.g. 409) is also collapsed to 400', async () => {
      const result = await postOrderWith({
        statusCode: 409,
        errorCode: ErrorCode.ValidationError,
        detail: 'Order already exists',
      });
      expect(result.statusCode).toEqual(400);
      expect(result).toMatchSnapshot();
    });

    it('indeterminate outcome (5xx) is mapped to 500 and keeps data.hash for reconciliation', async () => {
      const result = await postOrderWith({
        statusCode: 500,
        errorCode: ErrorCode.InternalError,
        detail: 'Timed out posting order to UniswapX Service; order acceptance could not be confirmed',
        data: { hash: '0xabc' },
      });
      expect(result.statusCode).toEqual(500);
      expect(result).toMatchSnapshot();
    });

    it('5xx without data omits the data key entirely', async () => {
      const result = await postOrderWith({
        statusCode: 500,
        errorCode: ErrorCode.InternalError,
        detail: 'Unknown Error posting to UniswapX Service',
      });
      expect(result.statusCode).toEqual(500);
      expect(result.body).not.toHaveProperty('data');
      expect(result).toMatchSnapshot();
    });

    it('postOrder throwing becomes a 400 OrderPostError (captured as-is)', async () => {
      // A thrown error is an indeterminate outcome (the order may have been accepted), yet it
      // surfaces as a final 400 rather than the 500 the resolved-5xx path uses. Pinned, not fixed.
      const request = await signedRequest(fixedOrder());
      const orderService = { postOrder: jest.fn().mockRejectedValue(new Error('socket hang up')) };
      const result = await invoke([new MockQuoter(logger, 1, 1)], orderService, JSON.stringify(request));
      expect(result.statusCode).toEqual(400);
      expect(result).toMatchSnapshot();
    });
  });

  describe('other handler-level errors', () => {
    it('404 NoQuotesAvailable when no quoter responds and allowNoQuote is unset', async () => {
      const request = await signedRequest(fixedOrder());
      const result = await invoke([], new MockOrderServiceProvider(), JSON.stringify(request));
      expect(result.statusCode).toEqual(404);
      expect(result).toMatchSnapshot();
    });

    it('400 Unknown cosigner when the order names a cosigner we do not hold', async () => {
      const request = await signedRequest(fixedOrder({ cosigner: swapperWallet.address }));
      const result = await invoke(
        [new MockQuoter(logger, 1, 1)],
        new MockOrderServiceProvider(),
        JSON.stringify(request)
      );
      expect(result.statusCode).toEqual(400);
      expect(result).toMatchSnapshot();
    });

    it('400 OrderDeadlineExpired when the V2 decay window would end after the deadline', async () => {
      // Mainnet decay ends 84s after now; a deadline 30s out cannot fit it.
      const request = await signedRequest(fixedOrder({ deadline: FIXED_NOW_S + 30 }));
      const result = await invoke(
        [new MockQuoter(logger, 1, 1)],
        new MockOrderServiceProvider(),
        JSON.stringify(request)
      );
      expect(result.statusCode).toEqual(400);
      expect(result).toMatchSnapshot();
    });
  });

  describe('400 request validation (Joi)', () => {
    // Joi runs with abortEarly (the default), so each body reports only its first violation.
    it.each<[string, (valid: HardQuoteRequestBody) => Record<string, unknown>]>([
      ['missing innerSig', ({ innerSig: _s, ...rest }) => rest],
      ['innerSig not a 64/65-byte hex string', (valid) => ({ ...valid, innerSig: '0x1234' })],
      ['missing encodedInnerOrder', ({ encodedInnerOrder: _e, ...rest }) => rest],
      ['non-uuid quoteId', (valid) => ({ ...valid, quoteId: 'not-a-uuid' })],
      ['missing requestId', ({ requestId: _r, ...rest }) => rest],
      ['tokenOutChainId differs from tokenInChainId', (valid) => ({ ...valid, tokenOutChainId: 10 })],
      ['allowNoQuote not a boolean', (valid) => ({ ...valid, allowNoQuote: 'yes' })],
      ['empty object', () => ({})],
    ])('%s', async (_name, mutate) => {
      const body = mutate(await signedRequest(fixedOrder()));
      const result = await invoke([new MockQuoter(logger, 1, 1)], new MockOrderServiceProvider(), JSON.stringify(body));
      expect(result.statusCode).toEqual(400);
      // Validation errors are produced before the request injector runs, so they carry no `id`.
      expect(result.body).not.toHaveProperty('id');
      expect(result).toMatchSnapshot();
    });
  });

  describe('malformed transport', () => {
    it('422 on a body that is not JSON', async () => {
      const result = await invoke([new MockQuoter(logger, 1, 1)], new MockOrderServiceProvider(), '{not json');
      expect(result.statusCode).toEqual(422);
      expect(result).toMatchSnapshot();
    });
  });
});
