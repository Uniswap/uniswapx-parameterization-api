import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import bunyan from 'bunyan';

import { QuoteInjector as HardQuoteInjector } from '../../../lib/handlers/hard-quote/injector';
import { QuoteInjector as SoftQuoteInjector } from '../../../lib/handlers/quote/injector';
import { SUPPORTED_CHAINS } from '../../../lib/util/chains';

/**
 * Wiring tests for the shared quote-injector factory.
 *
 * These exist because the container's most important property is not expressible in the
 * type system: the circuit breaker and the WebhookQuoter must hold the SAME
 * S3WebhookConfigurationProvider instance. The breaker takes the concrete class while the
 * quoter takes only the interface, so handing them two separate instances compiles fine
 * and fails silently in production (the breaker's timestamp map stays empty, so it fails
 * open and every benched filler is re-enabled with no error and no metric).
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
    ['soft quote', () => new SoftQuoteInjector('quoteInjector'), 'S3FillerComplianceConfigurationProvider', false],
    ['hard quote', () => new HardQuoteInjector('hardQuoteInjector'), 'MockFillerComplianceConfigurationProvider', true],
  ])('%s container', (_name, makeInjector, expectedComplianceProvider, expectsOrderService) => {
    let container: any;
    let quoter: any;

    beforeAll(async () => {
      container = (await (makeInjector() as any).build()).getContainerInjected();
      quoter = container.quoters[0];
    });

    it('shares ONE webhook provider between the circuit breaker and the quoter', () => {
      expect(quoter.webhookProvider).toBeDefined();
      expect(quoter.circuitBreakerProvider.webhookProvider).toBeDefined();
      // Compared as a boolean rather than with toBe(instance): a split yields two
      // structurally identical providers, so toBe would dump ~2kb of bunyan internals
      // and report only "serializes to the same string".
      const sharesOneInstance = quoter.circuitBreakerProvider.webhookProvider === quoter.webhookProvider;
      expect(sharesOneInstance).toBe(true);
    });

    it('shares one firehose logger between the container and the quoter', () => {
      expect(quoter.firehose).toBe(container.firehose);
    });

    it('registers exactly one quoter', () => {
      expect(container.quoters).toHaveLength(1);
    });

    it('scopes the webhook config bucket to the stage', () => {
      expect(quoter.webhookProvider.bucket).toContain('-beta-1');
    });

    it('uses the expected compliance provider for this lambda', () => {
      expect(quoter.complianceProvider.constructor.name).toEqual(expectedComplianceProvider);
    });

    it('builds one static RPC provider per supported chain', () => {
      expect(container.chainIdRpcMap.size).toEqual(SUPPORTED_CHAINS.length);

      const mainnet = container.chainIdRpcMap.get(1);
      expect(mainnet.connection.url).toEqual('https://rpc.example/1');
      expect(mainnet.connection.headers['x-uni-service-id']).toEqual('x_parameterization_api');
      // explicit network => no eth_chainId round trip on cold start
      expect(mainnet.network.chainId).toEqual(1);
    });

    it('provides the order service only where it is needed', () => {
      if (expectsOrderService) {
        expect(container.orderServiceProvider).toBeDefined();
      } else {
        expect(container.orderServiceProvider).toBeUndefined();
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
    });
  });
});
