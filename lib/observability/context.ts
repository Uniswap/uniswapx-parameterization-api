import { Logger } from './logger';
import { Metrics } from './metrics';

/**
 * Per-request observability handles, passed explicitly instead of read from module globals.
 * A module global holding request-scoped state is safe only while one container serves one
 * request at a time (Lambda); on a concurrent runtime (ECS) it is a cross-request leak. Field
 * names match the monorepo's ctx so handlers port without renames.
 *
 * `requestId` is the Lambda invocation id (context.awsRequestId), the value already bound onto
 * `logger` — not the client-supplied requestId in a quote body.
 */
export interface Context {
  logger: Logger;
  metrics: Metrics;
  requestId: string;
}
