import { KMSClient } from '@aws-sdk/client-kms';
import { KmsSigner } from '@uniswap/signer';
import { OrderType, UnsignedV2DutchOrder } from '@uniswap/uniswapx-sdk';
import { createMetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';
import { ethers, Wallet } from 'ethers';

import { HardQuoteRequest } from '../../../lib/entities';
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
import { CHAIN_ID, getOrder } from '../../fixtures/hard-quote';

/**
 * INVARIANT: on the hard-quote path, requestId is deliberately set equal to the indicative
 * quoteId. The client's own `requestId` (which the Joi schema nonetheless requires and
 * uuid-validates) is discarded.
 *
 * Where it happens: lib/handlers/hard-quote/handler.ts builds the request through
 * HardQuoteRequest.fromHardRequestBody, whose constructor (lib/entities/HardQuoteRequest.ts)
 * does `requestId: _data.quoteId ?? uuidv4()`. From there the substituted id flows into the
 * HardRequest log line, the QuoteRequest sent to fillers, the order-service POST
 * (`requestId: request.requestId`, and `quoteId` falls back to it for open orders), and the
 * HTTP response body.
 *
 * Why it must not be "fixed" as a bug: it is an analytics contract. The `hardrequests`
 * Redshift table has no quoteId column, so overwriting requestId is currently the only way the
 * indicative quoteId reaches Redshift; `hardrequests.requestid`, `hardresponses.requestid`, the
 * hard round's `rfqrequests`/`rfqresponses.requestid`, and `postedorders.quoteid` for open
 * orders are all keyed off it. It landed deliberately in commit e542951 (PR #317), which also
 * contains a reverted alternative. Changing the derivation requires a data-eng-workflows
 * change first (add a quoteId column to hard_requests.yaml), not a code change here.
 *
 * QUOTE_ID and REQUEST_ID below are deliberately different uuids; with aliased constants every
 * assertion in this file would be vacuous.
 */

jest.mock('axios');
jest.mock('@aws-sdk/client-kms');
jest.mock('@uniswap/signer');

const QUOTE_ID = 'a83f397c-8ef4-4801-a9b7-6e79155049f6';
const REQUEST_ID = 'b45c2d1e-7f30-4a92-8c65-1d8e4f2a9b03';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

process.env.KMS_KEY_ID = 'test-key-id';
process.env.REGION = 'us-east-2';

const swapperWallet = Wallet.createRandom();
const cosignerWallet = Wallet.createRandom();

const signedRequest = async (
  order: UnsignedV2DutchOrder,
  // `null` omits quoteId from the body; `undefined` would just re-trigger a default.
  quoteId: string | null
): Promise<HardQuoteRequestBody> => {
  const { types, domain, values } = order.permitData();
  const innerSig = await swapperWallet._signTypedData(domain, types, values);
  return {
    requestId: REQUEST_ID,
    ...(quoteId !== null && { quoteId }),
    tokenInChainId: CHAIN_ID,
    tokenOutChainId: CHAIN_ID,
    encodedInnerOrder: order.serialize(),
    innerSig,
  };
};

describe('hard-quote requestId := quoteId invariant', () => {
  describe('HardQuoteRequest (where the substitution happens)', () => {
    it('with a quoteId, requestId IS the quoteId and the client requestId is discarded', async () => {
      const body = await signedRequest(getOrder({}), QUOTE_ID);
      const request = HardQuoteRequest.fromHardRequestBody(body, OrderType.Dutch_V2);

      expect(request.requestId).toEqual(QUOTE_ID);
      expect(request.requestId).not.toEqual(REQUEST_ID);
      expect(request.quoteId).toEqual(QUOTE_ID);
    });

    it('propagates the substituted id to the request sent to fillers (rfqrequests.requestid)', async () => {
      const body = await signedRequest(getOrder({}), QUOTE_ID);
      const request = HardQuoteRequest.fromHardRequestBody(body, OrderType.Dutch_V2);

      expect(request.toCleanJSON().requestId).toEqual(QUOTE_ID);
      expect(request.toOpposingCleanJSON().requestId).toEqual(QUOTE_ID);
      expect(request.toQuoteRequest().requestId).toEqual(QUOTE_ID);
    });

    it('without a quoteId, mints a fresh uuid rather than keeping the client requestId', async () => {
      // Captured as-is: even when there is no quoteId to substitute, the client's requestId
      // is still not used.
      const body = await signedRequest(getOrder({}), null);
      const request = HardQuoteRequest.fromHardRequestBody(body, OrderType.Dutch_V2);

      expect(request.requestId).toMatch(UUID_V4);
      expect(request.requestId).not.toEqual(REQUEST_ID);
      expect(request.quoteId).toBeUndefined();
    });
  });

  describe('handler (where the substituted id becomes externally observable)', () => {
    beforeEach(() => {
      (KmsSigner as jest.Mock).mockImplementation(() => ({
        getAddress: jest.fn().mockResolvedValue(cosignerWallet.address),
        signDigest: jest
          .fn()
          .mockImplementation((digest: string) => cosignerWallet.signMessage(ethers.utils.arrayify(digest))),
      }));
      (KMSClient as jest.Mock).mockImplementation(() => jest.fn());
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

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

    const invoke = async (quoters: Quoter[], quoteId: string | null) => {
      const postOrder = jest.fn().mockResolvedValue({ statusCode: 201, data: { hash: '0xhash' } });
      const body = await signedRequest(getOrder({ cosigner: cosignerWallet.address }), quoteId);
      const handler = new HardQuoteHandler('hardQuote', injectorPromiseMock(quoters, { postOrder }));
      const response = await handler.handler(
        { body: JSON.stringify(body) } as APIGatewayProxyEvent,
        {} as unknown as Context
      );
      return { statusCode: response.statusCode, body: JSON.parse(response.body), postOrder };
    };

    it('echoes the quoteId as requestId in the response body', async () => {
      const { statusCode, body } = await invoke([new MockQuoter(logger, 1, 1)], QUOTE_ID);

      expect(statusCode).toEqual(200);
      expect(body.requestId).toEqual(QUOTE_ID);
      expect(body.quoteId).toEqual(QUOTE_ID);
      expect(body.requestId).not.toEqual(REQUEST_ID);
    });

    it('posts the order with requestId === quoteId === the indicative quoteId', async () => {
      const { postOrder } = await invoke([new MockQuoter(logger, 1, 1)], QUOTE_ID);

      expect(postOrder).toHaveBeenCalledTimes(1);
      const args = postOrder.mock.calls[0][0];
      expect(args.requestId).toEqual(QUOTE_ID);
      // MockQuoter echoes the request's quoteId, so bestQuote.quoteId is the indicative one too.
      expect(args.quoteId).toEqual(QUOTE_ID);
    });

    it('for an open order (no quote, no quoteId), quoteId falls back to the minted requestId', async () => {
      // handler.ts posts `quoteId: bestQuote?.quoteId ?? request.quoteId ?? request.requestId`.
      // With zero quoters and no quoteId both fall through to the minted id, so
      // postedorders.quoteid for open orders is the same uuid as the substituted requestId.
      // allowNoQuote is required to reach the post instead of a 404.
      const postOrder = jest.fn().mockResolvedValue({ statusCode: 201, data: { hash: '0xhash' } });
      const body = {
        ...(await signedRequest(getOrder({ cosigner: cosignerWallet.address }), null)),
        allowNoQuote: true,
      };
      const handler = new HardQuoteHandler('hardQuote', injectorPromiseMock([], { postOrder }));
      const response = await handler.handler(
        { body: JSON.stringify(body) } as APIGatewayProxyEvent,
        {} as unknown as Context
      );
      const responseBody = JSON.parse(response.body);

      expect(response.statusCode).toEqual(200);
      expect(responseBody.requestId).toMatch(UUID_V4);
      expect(responseBody.requestId).not.toEqual(REQUEST_ID);
      const args = postOrder.mock.calls[0][0];
      expect(args.requestId).toEqual(responseBody.requestId);
      expect(args.quoteId).toEqual(responseBody.requestId);
      // The HTTP body carries no quoteId for an open order; the id lives only in requestId.
      expect(responseBody.quoteId).toBeUndefined();
    });
  });
});
