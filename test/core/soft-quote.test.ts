import { default as Logger } from 'bunyan';
import { ethers } from 'ethers';

import { SoftQuoteBL } from '../../lib/core';
import { Metric, QuoteRequest } from '../../lib/entities';
import { ProtocolVersion } from '../../lib/providers';
import { MockQuoter } from '../../lib/quoters';
import { NoQuotesAvailable } from '../../lib/util/errors';
import { fakeContext } from '../fakes';

const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

const CHAIN_ID = 1;
const AMOUNT = ethers.utils.parseEther('1');

const request = (type: 'EXACT_INPUT' | 'EXACT_OUTPUT' = 'EXACT_INPUT'): QuoteRequest =>
  QuoteRequest.fromRequestBody({
    requestId: 'b45c2d1e-7f30-4a92-8c65-1d8e4f2a9b03',
    tokenInChainId: CHAIN_ID,
    tokenOutChainId: CHAIN_ID,
    swapper: '0x0000000000000000000000000000000000000000',
    tokenIn: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    tokenOut: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    amount: AMOUNT.toString(),
    type,
    numOutputs: 1,
    protocol: ProtocolVersion.V2,
  });

const softQuote = (quoters: MockQuoter[]) =>
  new SoftQuoteBL(quoters, new Map([[CHAIN_ID, new ethers.providers.StaticJsonRpcProvider()]]));

describe('SoftQuoteBL', () => {
  it('returns the highest-output quote for EXACT_INPUT, with every quote alongside it', async () => {
    const { ctx, metrics } = fakeContext();
    const { bestQuote, allQuotes } = await softQuote([
      new MockQuoter(logger, 1, 2),
      new MockQuoter(logger, 3, 2),
      new MockQuoter(logger, 1, 1),
    ]).getQuote(ctx, request());

    expect(bestQuote.amountOut.toString()).toEqual(AMOUNT.mul(3).div(2).toString());
    expect(allQuotes).toHaveLength(3);
    expect(metrics.emitted(Metric.QUOTE_REQUESTED)).toBe(1);
    expect(metrics.emitted(Metric.QUOTE_200)).toBe(1);
    expect(metrics.emitted(Metric.QUOTE_LATENCY)).toBe(1);
    expect(metrics.emitted(Metric.QUOTE_E2E_LATENCY)).toBe(1);
    expect(metrics.emitted(Metric.QUOTE_404)).toBe(0);
  });

  it('returns the lowest-input quote for EXACT_OUTPUT', async () => {
    const { ctx } = fakeContext();
    const { bestQuote } = await softQuote([new MockQuoter(logger, 3, 2), new MockQuoter(logger, 1, 2)]).getQuote(
      ctx,
      request('EXACT_OUTPUT')
    );

    expect(bestQuote.amountIn.toString()).toEqual(AMOUNT.div(2).toString());
  });

  it('logs the QuoteRequest analytics event that feeds the rfq_requests table', async () => {
    const { ctx, logger: fakeLogger } = fakeContext();
    await softQuote([new MockQuoter(logger, 1, 1)]).getQuote(ctx, request());

    const events = fakeLogger.records.filter((r) => r.fields.eventType === 'QuoteRequest');
    expect(events).toHaveLength(1);
    expect(events[0].msg).toBe('');
    expect(events[0].fields.body).toMatchObject({
      requestId: 'b45c2d1e-7f30-4a92-8c65-1d8e4f2a9b03',
      tokenInChainId: CHAIN_ID,
      amount: AMOUNT.toString(),
      type: 'EXACT_INPUT',
      numOutputs: 1,
    });
  });

  it('throws NoQuotesAvailable when no quoter answers, and still records end-to-end latency', async () => {
    const { ctx, metrics } = fakeContext();

    await expect(softQuote([]).getQuote(ctx, request())).rejects.toBeInstanceOf(NoQuotesAvailable);
    expect(metrics.emitted(Metric.QUOTE_REQUESTED)).toBe(1);
    expect(metrics.emitted(Metric.QUOTE_404)).toBe(1);
    expect(metrics.emitted(Metric.QUOTE_E2E_LATENCY)).toBe(1);
    expect(metrics.emitted(Metric.QUOTE_200)).toBe(0);
    expect(metrics.emitted(Metric.QUOTE_LATENCY)).toBe(0);
  });
});
