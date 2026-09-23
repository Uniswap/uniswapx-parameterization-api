import { Context } from '../../lib/observability';
import { FakeLogger } from './fake-logger';
import { FakeMetrics } from './fake-metrics';

export * from './fake-logger';
export * from './fake-metrics';

export interface FakeContext {
  ctx: Context;
  logger: FakeLogger;
  metrics: FakeMetrics;
}

/** A Context over fresh fakes, plus typed handles to them for assertions. */
export function fakeContext(requestId = 'test-request-id'): FakeContext {
  const logger = new FakeLogger({ requestId });
  const metrics = new FakeMetrics();
  return { ctx: { logger, metrics, requestId }, logger, metrics };
}
