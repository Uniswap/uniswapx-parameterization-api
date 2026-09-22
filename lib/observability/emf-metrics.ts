import { MetricsLogger, Unit } from 'aws-embedded-metrics';

import { Logger } from './logger';
import { MetricOptions, Metrics } from './metrics';

/**
 * Metrics over the request's existing aws-embedded-metrics logger.
 *
 * Delegation, not a new sink: the MetricsLogger passed in is the one the injector has already
 * configured (namespace, the Service / Service+ChainId / dimensionless dimension sets), so a
 * metric emitted here lands in the same EMF blob, under the same dimension sets, as one emitted
 * through the smart-order-router global — and every (name, value, unit) tuple is the one the
 * handlers emitted before the switch: count -> Count, timer -> Milliseconds, gauge -> None.
 *
 * Tags and dimensions in `opts` are accepted and dropped. EMF has no per-metric tags: dimension
 * sets are the injector's and out of scope here, and EMF properties are per-blob, so two metrics
 * in one request carrying different `status:` tags would overwrite each other. The StatsD sink
 * applies them.
 *
 * Never throws and never rejects. aws-embedded-metrics validates on putMetric (non-finite value,
 * bad name or unit) and before this adapter that exception surfaced as a 500 on the quote; here
 * it is logged and the metric dropped. Emission happens synchronously inside the async methods,
 * so a `void`-ed call has landed before the caller continues.
 */
export class EmfMetrics implements Metrics {
  constructor(private readonly emf: MetricsLogger, private readonly logger: Logger) {}

  public async count(name: string, val = 1, _opts?: Partial<MetricOptions>): Promise<void> {
    this.put(name, val, Unit.Count);
  }

  public async timer(name: string, val: number, _opts?: Partial<MetricOptions>): Promise<void> {
    this.put(name, val, Unit.Milliseconds);
  }

  public async gauge(name: string, val: number, _opts?: Partial<MetricOptions>): Promise<void> {
    this.put(name, val, Unit.None);
  }

  private put(name: string, value: number, unit: Unit): void {
    try {
      this.emf.putMetric(name, value, unit);
    } catch (err) {
      this.logger.warn('Dropped metric rejected by aws-embedded-metrics', { err, metric: name, value, unit });
    }
  }
}
