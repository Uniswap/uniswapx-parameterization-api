import bunyan from 'bunyan';

import { loadQuoteConfig } from '../../../lib/config';
import { HardQuoteInjector } from '../../../lib/handlers/hard-quote';
import { QuoteInjector } from '../../../lib/handlers/quote/injector';
import { buildQuoteContainerInjected } from '../../../lib/handlers/shared/quote-injector';
import { S3WebhookConfigurationProvider } from '../../../lib/providers';
import { DirectQuoteAnalytics, QUOTE_ANALYTICS_STREAM_ENV } from '../../../lib/providers/analytics';
import { DynamoCircuitBreakerConfigurationProvider } from '../../../lib/providers/circuit-breaker/dynamo';
import { WebhookQuoter } from '../../../lib/quoters';

/**
 * Pins the shape of the RFQ container buildQuoteContainerInjected builds: one WebhookQuoter
 * wired to a Dynamo circuit breaker and an S3 webhook config provider.
 *
 * The breaker used to read its filler list from the webhook provider's in-memory cache, which
 * made sharing one provider instance load-bearing (a split failed the breaker open) and left
 * the list frozen at the container's first request. It now scores the endpoints the quoter
 * passes it, so the last test asserts it holds no provider at all: re-adding one would bring
 * that coupling back.
 *
 * The test drives the shared factory directly rather than an injector so that it survives
 * the injector classes being reshaped, and reaches into private fields via `any` because the
 * wiring is deliberately not exposed on the public surface.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const log = bunyan.createLogger({ name: 'quote-container-invariants.test', level: bunyan.FATAL });

const ENV_KEYS = [
  'stage',
  'RPC_PREFIX_URL',
  'ANALYTICS_STREAM_ARN',
  'ORDER_SERVICE_URL',
  'KMS_KEY_ID',
  'REGION',
  ...Object.values(QUOTE_ANALYTICS_STREAM_ENV),
] as const;
const savedEnv: Partial<Record<string, string | undefined>> = {};

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // buildChainIdRpcMap throws without a prefix; the firehose ARN is only stored, never used
  // at construction time. No I/O happens: every AWS client in the graph is lazy.
  process.env.RPC_PREFIX_URL = 'https://rpc.example/';
  process.env.ANALYTICS_STREAM_ARN = 'arn:aws:firehose:us-east-2:123456789012:deliverystream/dummy';
  process.env.stage = 'beta';
  process.env.KMS_KEY_ID = 'test-key-id';
  process.env.REGION = 'us-east-2';
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('buildQuoteContainerInjected wiring invariants', () => {
  describe.each(['beta', 'prod'])('stage=%s', (stage) => {
    let quoter: any;

    beforeAll(() => {
      const container = buildQuoteContainerInjected(log, loadQuoteConfig({ ...process.env, stage }));
      expect(container.quoters).toHaveLength(1);
      quoter = container.quoters[0];
    });

    it('the single quoter is a WebhookQuoter wired to a Dynamo circuit breaker', () => {
      expect(quoter).toBeInstanceOf(WebhookQuoter);
      expect(quoter.circuitBreakerProvider).toBeInstanceOf(DynamoCircuitBreakerConfigurationProvider);
      expect(quoter.webhookProvider).toBeInstanceOf(S3WebhookConfigurationProvider);
    });

    it('the circuit breaker holds no webhook config provider', () => {
      const providerFields = Object.values(quoter.circuitBreakerProvider).filter(
        (v) => v instanceof S3WebhookConfigurationProvider
      );
      expect(providerFields).toHaveLength(0);
    });
  });
});

/**
 * Direct quote analytics only works if the flow, the quoter and the handler share ONE sink: the
 * flow and quoter queue records, and the handler flushes the container's sink before the Lambda
 * returns. A second instance anywhere would queue records nobody sends.
 */
describe('quote analytics sink wiring (stream names set)', () => {
  beforeAll(() => {
    process.env.ORDER_SERVICE_URL = 'https://orders.example/';
    for (const [eventType, key] of Object.entries(QUOTE_ANALYTICS_STREAM_ENV)) process.env[key] = `stream-${eventType}`;
  });

  it('/quote: the handler flushes the same sink the flow and the quoter write to', async () => {
    const container: any = await new QuoteInjector('quote-invariants').buildContainerInjected();
    expect(container.analytics).toBeInstanceOf(DirectQuoteAnalytics);
    expect(container.softQuote.analytics).toBe(container.analytics);
    expect(container.softQuote.quoters[0].analytics).toBe(container.analytics);
    expect(Object.keys(container.analytics.streams).sort()).toEqual(['QuoteRequest', 'QuoteResponse']);
  });

  it('/hard-quote: the handler flushes the same sink the flow and the quoter write to', async () => {
    const container: any = await new HardQuoteInjector('hard-quote-invariants').buildContainerInjected();
    expect(container.analytics).toBeInstanceOf(DirectQuoteAnalytics);
    expect(container.hardQuote.deps.analytics).toBe(container.analytics);
    expect(container.hardQuote.deps.quoters[0].analytics).toBe(container.analytics);
    expect(Object.keys(container.analytics.streams).sort()).toEqual(['HardRequest', 'HardResponse']);
  });
});
