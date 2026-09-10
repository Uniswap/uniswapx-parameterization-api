import { MetricsLogger, Unit } from 'aws-embedded-metrics';

import { Logger } from './logger';
import { Metrics, MetricTags } from './metrics';

/**
 * Metrics over the request's existing aws-embedded-metrics logger.
 *
 * Delegation, not a new sink: the MetricsLogger passed in is the one the injector has already
 * configured (namespace, the Service / Service+ChainId / dimensionless dimension sets), so a
 * metric emitted here lands in the same EMF blob, under the same dimension sets, as one emitted
 * through the smart-order-router global — and every (name, value, unit) tuple is the one the
 * handlers emitted before the switch: increment -> Count, histogram -> Milliseconds,
 * gauge -> None.
 *
 * Tags are accepted and dropped. EMF has no per-metric tags: dimensions are the injector's and
 * out of scope here, and EMF properties are per-blob, so two metrics in one request carrying
 * different `status` tags would overwrite each other. The StatsD sink honours them.
 *
 * Never throws. aws-embedded-metrics validates on putMetric (non-finite value, bad name or
 * unit) and today that exception surfaces as a 500 on the quote; here it is logged and dropped.
 */
export class EmfMetrics implements Metrics {
  constructor(private readonly emf: MetricsLogger, private readonly logger: Logger) {}

  public increment(name: string, value = 1, _tags?: MetricTags): void {
    this.put(name, value, Unit.Count);
  }

  public gauge(name: string, value: number, _tags?: MetricTags): void {
    this.put(name, value, Unit.None);
  }

  public histogram(name: string, value: number, _tags?: MetricTags): void {
    this.put(name, value, Unit.Milliseconds);
  }

  private put(name: string, value: number, unit: Unit): void {
    try {
      this.emf.putMetric(name, value, unit);
    } catch (err) {
      this.logger.warn({ err, metric: name, value, unit }, 'Dropped metric rejected by aws-embedded-metrics');
    }
  }
}
