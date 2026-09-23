import bunyan from 'bunyan';

import { buildQuoteContainerInjected } from '../../../lib/handlers/shared/quote-injector';
import { S3WebhookConfigurationProvider } from '../../../lib/providers';
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

const ENV_KEYS = ['RPC_PREFIX_URL', 'ANALYTICS_STREAM_ARN'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // buildChainIdRpcMap throws without a prefix; the firehose ARN is only stored, never used
  // at construction time. No I/O happens: every AWS client in the graph is lazy.
  process.env.RPC_PREFIX_URL = 'https://rpc.example/';
  process.env.ANALYTICS_STREAM_ARN = 'arn:aws:firehose:us-east-2:1:deliverystream/dummy';
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
      const container = buildQuoteContainerInjected(log, stage);
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
