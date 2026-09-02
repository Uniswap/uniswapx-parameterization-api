import bunyan from 'bunyan';

import { buildQuoteContainerInjected } from '../../../lib/handlers/shared/quote-injector';
import { S3WebhookConfigurationProvider } from '../../../lib/providers';
import { DynamoCircuitBreakerConfigurationProvider } from '../../../lib/providers/circuit-breaker/dynamo';
import { MockFillerComplianceConfigurationProvider } from '../../../lib/providers/compliance';
import { WebhookQuoter } from '../../../lib/quoters';

/**
 * INVARIANT: buildQuoteContainerInjected creates exactly ONE S3WebhookConfigurationProvider
 * and hands that same instance to both the DynamoCircuitBreakerConfigurationProvider and the
 * WebhookQuoter.
 *
 * Why this is pinned by reference equality and not left to the compiler (see the comment on
 * the factory at lib/handlers/shared/quote-injector.ts): the breaker reads
 * `webhookProvider.fillerEndpoints()`, an in-memory cache that is populated only by the
 * quoter calling `getEndpoints()` one line earlier in the request path. Give the breaker its
 * own instance and that cache is always empty, so its timestamp map is empty, so
 * getEndpointStatuses() returns every endpoint as enabled -- the circuit breaker fails OPEN.
 * Every benched filler is silently re-enabled with no error and no metric. The types allow
 * the split: the breaker's constructor takes the concrete S3WebhookConfigurationProvider
 * while WebhookQuoter takes only the WebhookConfigurationProvider interface, so passing two
 * separately constructed (and structurally identical) instances compiles cleanly.
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
      const container = buildQuoteContainerInjected(log, stage, new MockFillerComplianceConfigurationProvider([]));
      expect(container.quoters).toHaveLength(1);
      quoter = container.quoters[0];
    });

    it('the single quoter is a WebhookQuoter wired to a Dynamo circuit breaker', () => {
      expect(quoter).toBeInstanceOf(WebhookQuoter);
      expect(quoter.circuitBreakerProvider).toBeInstanceOf(DynamoCircuitBreakerConfigurationProvider);
      expect(quoter.webhookProvider).toBeInstanceOf(S3WebhookConfigurationProvider);
    });

    it('the circuit breaker and the quoter hold the SAME S3WebhookConfigurationProvider instance', () => {
      const breakerProvider = quoter.circuitBreakerProvider.webhookProvider;
      expect(breakerProvider).toBeDefined();
      // Compared as a boolean rather than toBe(instance): on failure toBe would dump both
      // providers' bunyan internals and report only "serializes to the same string", which is
      // precisely the trap -- a split yields two structurally identical objects.
      const isSameInstance = breakerProvider === quoter.webhookProvider;
      expect(isSameInstance).toBe(true);
    });
  });
});
