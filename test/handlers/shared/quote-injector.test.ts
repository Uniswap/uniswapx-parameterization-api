import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import bunyan from 'bunyan';

import { QuoteInjector as HardQuoteInjector } from '../../../lib/handlers/hard-quote/injector';
import { QuoteInjector as SoftQuoteInjector } from '../../../lib/handlers/quote/injector';
import { SUPPORTED_CHAINS } from '../../../lib/util/chains';

/**
 * Wiring tests for the shared quote-injector factory.
 *
 * buildContainerInjected does no I/O — every AWS client in the graph is constructed lazily
 * and the RPC providers are given an explicit network — so these run offline with no
 * credentials.
 */

// Quieted so building a real container doesn't spam the test output.
const log = bunyan.createLogger({ name: 'quote-injector.test', level: bunyan.FATAL });

/* eslint-disable @typescript-eslint/no-explicit-any */

beforeAll(() => {
  process.env.stage = 'beta';
  process.env.RPC_PREFIX_URL = 'https://rpc.example/';
  process.env.ANALYTICS_STREAM_ARN = 'arn:aws:firehose:us-east-2:1:deliverystream/dummy';
  process.env.ORDER_SERVICE_URL = 'https://order.example';
});

function stubMetricsLogger() {
  return {
    setNamespace: jest.fn(),
    setDimensions: jest.fn(),
    putDimensions: jest.fn(),
    putMetric: jest.fn(),
    setProperty: jest.fn(),
  };
}

describe('shared quote injector wiring', () => {
  describe.each([
    ['soft quote', () => new SoftQuoteInjector('quoteInjector'), 'softQuote', false],
    ['hard quote', () => new HardQuoteInjector('hardQuoteInjector'), 'hardQuote', true],
  ])('%s container', (_name, makeInjector, flowKey, expectsOrderService) => {
    let container: any;
    // What the injector wired into the flow. The handler-facing container holds only the flow, so
    // this reaches into its private fields.
    let wiring: any;
    let quoter: any;

    beforeAll(async () => {
      container = (await (makeInjector() as any).build()).getContainerInjected();
      const flow = container[flowKey];
      wiring = flow.deps ?? { quoters: flow.quoters, chainIdRpcMap: flow.chainIdRpcMap };
      quoter = wiring.quoters[0];
    });

    it('exposes only its flow to the handler', () => {
      expect(Object.keys(container)).toEqual([flowKey]);
    });

    it('gives the quoter a firehose logger for its analytics events', () => {
      expect(quoter.firehose).toBeDefined();
    });

    it('registers exactly one quoter', () => {
      expect(wiring.quoters).toHaveLength(1);
    });

    it('scopes the webhook config bucket to the stage', () => {
      expect(quoter.webhookProvider.bucket).toContain('-beta-1');
    });

    it('builds one static RPC provider per supported chain', () => {
      expect(wiring.chainIdRpcMap.size).toEqual(SUPPORTED_CHAINS.length);

      const mainnet = wiring.chainIdRpcMap.get(1);
      expect(mainnet.connection.url).toEqual('https://rpc.example/1');
      expect(mainnet.connection.headers['x-uni-service-id']).toEqual('x_parameterization_api');
      // explicit network => no eth_chainId round trip on cold start
      expect(mainnet.network.chainId).toEqual(1);
    });

    it('keeps filler-address attribution out of the quoter and in the hard-quote flow only', () => {
      expect(quoter.repository).toBeUndefined();
      if (expectsOrderService) {
        expect(wiring.fillerAddressRepository).toBeDefined();
      } else {
        expect(wiring.fillerAddressRepository).toBeUndefined();
      }
    });

    it('provides the order service only where it is needed', () => {
      if (expectsOrderService) {
        expect(wiring.orderServiceProvider).toBeDefined();
        expect(wiring.postedOrderRepository).toBeDefined();
        expect(wiring.cosignerFactory).toBeDefined();
      } else {
        expect(wiring.orderServiceProvider).toBeUndefined();
        expect(wiring.postedOrderRepository).toBeUndefined();
        expect(wiring.cosignerFactory).toBeUndefined();
      }
    });
  });

  describe('getRequestInjected', () => {
    it.each([
      ['soft quote', () => new SoftQuoteInjector('quoteInjector'), 'SoftQuote', 42161],
      ['hard quote', () => new HardQuoteInjector('hardQuoteInjector'), 'HardQuote', 1],
    ])('sets the %s metric dimensions and request id', async (_name, makeInjector, service, chainId) => {
      const metricsLogger = stubMetricsLogger();

      const requestInjected = await (makeInjector() as any).getRequestInjected(
        {} as any,
        { tokenInChainId: chainId } as any,
        undefined,
        {} as APIGatewayProxyEvent,
        { awsRequestId: 'req-1' } as Context,
        log,
        metricsLogger as unknown as MetricsLogger
      );

      expect(metricsLogger.setNamespace).toHaveBeenCalledWith('Uniswap');
      expect(metricsLogger.setDimensions).toHaveBeenCalledWith({ Service: service });
      expect(metricsLogger.putDimensions).toHaveBeenCalledWith({
        Service: service,
        ChainId: chainId.toString(),
      });
      // Order is load-bearing, so assert it rather than just the payloads: setDimensions
      // REPLACES the dimension-set list while putDimensions APPENDS, so reversing the two
      // silently drops the per-chain dimension set from every metric.
      expect(metricsLogger.setDimensions.mock.invocationCallOrder[0]).toBeLessThan(
        metricsLogger.putDimensions.mock.invocationCallOrder[0]
      );
      expect(requestInjected.requestId).toEqual('req-1');
      // The child logger is what carries requestBody/requestId onto every downstream log line.
      expect(requestInjected.log).not.toBe(log);
      expect(requestInjected.log.fields.requestId).toEqual('req-1');

      // ctx is a second view of the same request-scoped state, not a second copy of it: the
      // handler layer's logger writes through that same child logger (message-first in, bunyan's
      // fields-first out), and its metrics forward to the request's MetricsLogger (the one
      // carrying the dimension sets asserted above) as the same (name, value, unit) the IMetric
      // path produced.
      expect(requestInjected.ctx.requestId).toEqual('req-1');
      const childInfo = jest.spyOn(requestInjected.log, 'info');
      requestInjected.ctx.logger.info('bestQuote', { bestQuote: 'q' });
      expect(childInfo).toHaveBeenCalledWith({ bestQuote: 'q' }, 'bestQuote');
      await requestInjected.ctx.metrics.count('QUOTE_REQUESTED');
      await requestInjected.ctx.metrics.timer('QUOTE_LATENCY', 250);
      expect(metricsLogger.putMetric.mock.calls).toEqual([
        ['QUOTE_REQUESTED', 1, 'Count'],
        ['QUOTE_LATENCY', 250, 'Milliseconds'],
      ]);
    });
  });
});
