import { default as Logger } from 'bunyan';
import { Wallet } from 'ethers';

import { HardQuoteBL } from '../../lib/core';
import { Metric } from '../../lib/entities';
import { ErrorResponse } from '../../lib/handlers/base';
import { HardQuoteRequestBody } from '../../lib/handlers/hard-quote';
import { OrderServiceProvider, PostOrderArgs, UniswapXServiceResponse } from '../../lib/providers/order';
import { MockQuoter } from '../../lib/quoters';
import { ErrorCode, NoQuotesAvailable } from '../../lib/util/errors';
import { fakeContext, FakeCosigner, hardQuoteContainer } from '../fakes';
import { getOrder } from '../fixtures/hard-quote';

const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

/** Order service that answers every post with one scripted response and records what it got. */
class ScriptedOrderService implements OrderServiceProvider {
  public readonly posted: PostOrderArgs[] = [];

  constructor(private readonly response: ErrorResponse | UniswapXServiceResponse) {}

  public async postOrder(args: PostOrderArgs): Promise<ErrorResponse | UniswapXServiceResponse> {
    this.posted.push(args);
    return this.response;
  }
}

describe('HardQuoteBL', () => {
  const swapperWallet = Wallet.createRandom();
  const cosignerWallet = Wallet.createRandom();
  const cosigner = new FakeCosigner(cosignerWallet);

  const requestBody = async (): Promise<HardQuoteRequestBody> => {
    const order = getOrder({ cosigner: cosignerWallet.address });
    const { types, domain, values } = order.permitData();
    return {
      requestId: 'a83f397c-8ef4-4801-a9b7-6e79155049f6',
      tokenInChainId: 1,
      tokenOutChainId: 1,
      encodedInnerOrder: order.serialize(),
      innerSig: await swapperWallet._signTypedData(domain, types, values),
    };
  };

  // A 2:1 quote beats the swapper's price, so the order gets cosigned with an exclusive filler.
  const flow = (orderServiceProvider: OrderServiceProvider, quoters = [new MockQuoter(logger, 2, 1)]): HardQuoteBL =>
    hardQuoteContainer({ quoters, orderServiceProvider, cosignerFactory: cosigner.factory() }).hardQuote;

  it('returns the response body when the order service accepts the order', async () => {
    const { ctx, metrics } = fakeContext();
    const orderService = new ScriptedOrderService({ statusCode: 201, data: { hash: '0xhash' } });

    const outcome = await flow(orderService).getHardQuote(ctx, await requestBody());

    expect(outcome.kind).toEqual('posted');
    expect(orderService.posted).toHaveLength(1);
    expect(metrics.emitted(Metric.QUOTE_200)).toBe(1);
    expect(metrics.emitted(Metric.QUOTE_LATENCY)).toBe(1);
    expect(metrics.emitted(Metric.QUOTE_E2E_LATENCY)).toBe(1);
  });

  it('reports a 4xx from the order service as a rejection, carrying its error', async () => {
    const { ctx, metrics } = fakeContext();
    const error: ErrorResponse = { statusCode: 400, errorCode: ErrorCode.ValidationError, detail: 'rejected' };

    const outcome = await flow(new ScriptedOrderService(error)).getHardQuote(ctx, await requestBody());

    expect(outcome).toEqual({ kind: 'rejected', error });
    expect(metrics.emitted(Metric.QUOTE_400)).toBe(1);
    expect(metrics.emitted(Metric.QUOTE_200)).toBe(0);
  });

  it('reports a 5xx or timeout as indeterminate, never as a rejection', async () => {
    const { ctx, metrics } = fakeContext();
    const error: ErrorResponse = { statusCode: 500, errorCode: ErrorCode.InternalError, detail: 'timed out' };

    const outcome = await flow(new ScriptedOrderService(error)).getHardQuote(ctx, await requestBody());

    expect(outcome).toEqual({ kind: 'indeterminate', error });
    expect(metrics.emitted(Metric.QUOTE_500)).toBe(1);
    expect(metrics.emitted(Metric.QUOTE_400)).toBe(0);
  });

  it('throws NoQuotesAvailable and posts nothing when no quoter answers', async () => {
    const { ctx, metrics } = fakeContext();
    const orderService = new ScriptedOrderService({ statusCode: 201, data: { hash: '0xhash' } });

    await expect(flow(orderService, []).getHardQuote(ctx, await requestBody())).rejects.toBeInstanceOf(
      NoQuotesAvailable
    );
    expect(orderService.posted).toHaveLength(0);
    expect(metrics.emitted(Metric.QUOTE_E2E_LATENCY)).toBe(1);
  });
});
