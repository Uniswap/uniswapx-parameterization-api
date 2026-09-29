import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { metricScope, MetricsLogger } from 'aws-embedded-metrics';
import { ScheduledHandler } from 'aws-lambda/trigger/cloudwatch-events';
import { EventBridgeEvent } from 'aws-lambda/trigger/eventbridge';
import Logger from 'bunyan';
import { randomUUID } from 'crypto';

import {
  BETA_S3_KEY,
  FADES_COUNT_NEVER_FILLED_TERMINAL_AS_FADE_ENV,
  PRODUCTION_S3_KEY,
  WEBHOOK_CONFIG_BUCKET,
} from '../constants';
import { CircuitBreakerBL, CircuitBreakerDeps } from '../core/circuit-breaker';
import { CircuitBreakerMetricDimension } from '../entities';
import { BunyanLogger, Context, EmfMetrics } from '../observability';
import { checkDefined } from '../preconditions/preconditions';
import { S3WebhookConfigurationProvider, UniswapXServiceProvider } from '../providers';
import { DynamoFillerAddressRepository } from '../repositories/filler-address-repository';
import { DynamoPostedOrderRepository } from '../repositories/posted-order-repository';
import { TimestampRepository } from '../repositories/timestamp-repository';
import { STAGE } from '../util/stage';
import { OrderServiceFadesSource } from './order-service-fades-source';

// Time kept in hand at the end of an invocation: the source's best-effort outcome resolution stops
// starting order-service batches this far before the Lambda deadline, so a slow order service
// truncates resolution (finished next run) rather than the run.
export const LAMBDA_EXIT_MARGIN_MS = 30_000;

const log = Logger.createLogger({
  name: 'FadeRate',
  serializers: Logger.stdSerializers,
});
const defaultLog = log;

/* set up aws clients */
const stage = process.env['stage'];
const s3Key = stage === STAGE.BETA ? BETA_S3_KEY : PRODUCTION_S3_KEY;
const webhookProvider = new S3WebhookConfigurationProvider(log, `${WEBHOOK_CONFIG_BUCKET}-${stage}-1`, s3Key);
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: {
    convertEmptyValues: true,
  },
  unmarshallOptions: {
    wrapNumbers: true,
  },
});
const fillerAddressRepo = DynamoFillerAddressRepository.create(documentClient);
const timestampDB = TimestampRepository.create();

export const handler: ScheduledHandler = metricScope(
  (metrics) => async (_event: EventBridgeEvent<string, void>, context) => {
    await main(metrics, () => context.getRemainingTimeInMillis(), context.awsRequestId);
  }
);

/**
 * The breaker's dependencies plus what the Lambda invocation supplies, injectable so the run can
 * be exercised end to end through the real logger and metrics adapters. Production wiring is in
 * main(); the shared module-level clients above are what it passes.
 */
export type FadeRateCronDeps = CircuitBreakerDeps & {
  log?: Logger;
  // Milliseconds left in the Lambda invocation. When present, the source's best-effort outcome
  // resolution is bounded to it minus LAMBDA_EXIT_MARGIN_MS; without it, unbounded.
  remainingTimeMs?: () => number;
  // The Lambda invocation id, for the run's Context. Absent in tests.
  requestId?: string;
};

async function main(metrics: MetricsLogger, remainingTimeMs: () => number, requestId: string) {
  await runFadeRateCron(metrics, {
    source: buildOrderServiceSource(),
    webhookProvider,
    fillerAddressRepo,
    timestampDB,
    remainingTimeMs,
    requestId,
  });
}

/** Production wiring of the fades source (lib/cron/order-service-fades-source.ts). */
function buildOrderServiceSource(): OrderServiceFadesSource {
  const orderServiceUrl = checkDefined(process.env.ORDER_SERVICE_URL, 'ORDER_SERVICE_URL is not defined');
  return new OrderServiceFadesSource({
    postedOrders: DynamoPostedOrderRepository.create(
      // Not the hard-quote path's 200/300ms-bounded client: the cron is not in series with a
      // quote.
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { convertEmptyValues: true, removeUndefinedValues: true },
        unmarshallOptions: { wrapNumbers: false },
      })
    ),
    orderStatus: new UniswapXServiceProvider(log, orderServiceUrl),
    fillerEndpoints: () => webhookProvider.fillerEndpoints(),
    log,
    // Policy flag (default off): cancelled / insufficient-funds / error orders are excluded, as
    // the retired Redshift breaker effectively excluded them. 'true' scores them as fades.
    // Expiries always count regardless.
    policy: { countNeverFilledTerminalAsFade: process.env[FADES_COUNT_NEVER_FILLED_TERMINAL_AS_FADE_ENV] === 'true' },
  });
}

/**
 * The Lambda adapter around CircuitBreakerBL: scopes the invocation's EMF metrics to the
 * CircuitBreaker dimension, builds the run's Context over them and the bunyan logger, and turns
 * the invocation's remaining time into the source's resolution deadline.
 */
export async function runFadeRateCron(metrics: MetricsLogger, deps: FadeRateCronDeps): Promise<void> {
  const { log: depsLog, remainingTimeMs, requestId, ...breakerDeps } = deps;
  metrics.setNamespace('Uniswap');
  // Everything the run emits — its own metrics and the webhook config refresh's
  // RFQ_CONFIG_CHANGED — lands under Service=CircuitBreaker; the dashboard's config-change strip
  // charts that stream alongside the quote lambdas' dimensionless one.
  metrics.setDimensions(CircuitBreakerMetricDimension);
  const logger = new BunyanLogger(depsLog ?? defaultLog);
  const ctx: Context = { logger, metrics: new EmfMetrics(metrics, logger), requestId: requestId ?? randomUUID() };

  await new CircuitBreakerBL(breakerDeps).run(ctx, {
    deadlineMs: remainingTimeMs ? Date.now() + Math.max(0, remainingTimeMs() - LAMBDA_EXIT_MARGIN_MS) : undefined,
  });
}
