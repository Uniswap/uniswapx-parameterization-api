import { IMetric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import Logger from 'bunyan';

import { Metric, QuoteResponse } from '../../entities';
import { FillerAddressRepository } from '../../repositories/filler-address-repository';

/**
 * Attributes the winning quote's on-chain address to the webhook that returned it, so the
 * fade-rate breaker can map the posted order's exclusive filler back to an endpoint.
 *
 * Fire-and-forget and never throws: attribution is best-effort bookkeeping, and the quote has
 * already been won by the time this runs. On 2026-09-07 a rejected (throttled) write on this
 * path surfaced as an unhandled rejection and 5xx'd /quote; the .catch here is what stops a
 * DynamoDB problem from ever failing a quote again.
 */
export function recordWinningFiller(params: {
  repository: FillerAddressRepository;
  quote: QuoteResponse;
  log: Logger;
  metric: IMetric;
}): void {
  const { repository, quote, log, metric } = params;
  if (!quote.filler) {
    return;
  }
  repository.recordWinningAddress(quote.filler, quote.endpoint).catch((err) => {
    metric.putMetric(Metric.FILLER_ADDRESS_RECORD_FAILED, 1, MetricLoggerUnit.Count);
    log.warn(
      { err, filler: quote.filler, endpoint: quote.endpoint },
      'failed to record winning filler address; quote unaffected, attribution skipped'
    );
  });
}
