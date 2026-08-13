import { IMetric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import { MetricsLogger as AWSEmbeddedMetricsLogger } from 'aws-embedded-metrics';

export const UniswapXParamServiceMetricDimension = {
  Service: 'UniswapXParameterizationAPI',
};

export const CircuitBreakerMetricDimension = {
  Service: 'CircuitBreaker',
};

export const SoftQuoteMetricDimension = {
  Service: 'SoftQuote',
};

export const HardQuoteMetricDimension = {
  Service: 'HardQuote',
};

export class AWSMetricsLogger implements IMetric {
  constructor(private awsMetricLogger: AWSEmbeddedMetricsLogger) {}

  public setProperty(key: string, value: unknown): void {
    this.awsMetricLogger.setProperty(key, value);
  }

  public putDimensions(dimensions: Record<string, string>): void {
    this.awsMetricLogger.putDimensions(dimensions);
  }

  public putMetric(key: string, value: number, unit?: MetricLoggerUnit): void {
    this.awsMetricLogger.putMetric(key, value, unit);
  }
}

export enum MetricDimension {
  METHOD = 'method',
}

export enum Metric {
  QUOTE_200 = 'QUOTE_200',
  QUOTE_400 = 'QUOTE_400',
  QUOTE_404 = 'QUOTE_404',
  QUOTE_500 = 'QUOTE_500',

  QUOTE_REQUESTED = 'QUOTE_REQUESTED',
  QUOTE_LATENCY = 'QUOTE_LATENCY',
  HANDLER_DURATION = 'HANDLER_DURATION',

  QUOTE_POST_ERROR = 'QUOTE_POST_ERROR',
  QUOTE_POST_ATTEMPT = 'QUOTE_POST_ATTEMPT',

  RFQ_REQUESTED = 'RFQ_REQUESTED',
  RFQ_SUCCESS = 'RFQ_SUCCESS',
  RFQ_RESPONSE_TIME = 'RFQ_RESPONSE_TIME',
  RFQ_FAIL_REQUEST_MATCH = 'RFQ_FAIL_REQUEST_MATCH',
  RFQ_NON_QUOTE = 'RFQ_NON_QUOTE',
  RFQ_FAIL_VALIDATION = 'RFQ_FAIL_VALIDATION',
  RFQ_FAIL_ERROR = 'RFQ_FAIL_ERROR',
  RFQ_COUNT_0 = 'RFQ_COUNT_0',
  RFQ_COUNT_1 = 'RFQ_COUNT_1',
  RFQ_COUNT_2 = 'RFQ_COUNT_2',
  RFQ_COUNT_3 = 'RFQ_COUNT_3',
  RFQ_COUNT_4_PLUS = 'RFQ_COUNT_4_PLUS',

  // Latency-attribution metrics.
  // Time spent resolving webhook config + circuit-breaker state before fan-out.
  RFQ_PHASE_ENDPOINT_STATUSES = 'RFQ_PHASE_ENDPOINT_STATUSES',
  // Time spent resolving the compliance exclusion map before fan-out.
  RFQ_PHASE_COMPLIANCE = 'RFQ_PHASE_COMPLIANCE',
  // Wall time the request blocks on the webhook fan-out Promise.all.
  RFQ_PHASE_FANOUT = 'RFQ_PHASE_FANOUT',
  // Fan-out wall time minus the latency of the last response that produced a usable
  // quote — the time every swapper waits for endpoints that contributed nothing. Equals
  // the full fan-out wall when no endpoint produced a usable quote.
  RFQ_WASTED_WAIT = 'RFQ_WASTED_WAIT',
  // Emitted once per fan-out for the endpoint that finished last (set the wall).
  RFQ_STRAGGLER = 'RFQ_STRAGGLER',
  // Webhook attempts that hit the axios timeout (ECONNABORTED). A strict subset of
  // RFQ_FAIL_ERROR, split out because timeouts are the wasted-wait driver.
  RFQ_TIMEOUT = 'RFQ_TIMEOUT',
  // End-to-end handler latency on every response path (200, 404, thrown errors), unlike
  // QUOTE_LATENCY which fires only on 200s and is blind to slow 404s.
  QUOTE_E2E_LATENCY = 'QUOTE_E2E_LATENCY',
  // Emitted when a config refresh observes a different RFQ filler config than the
  // previous fetch on the same instance. Marks config-repo changes (filler adds/
  // removals) on the latency dashboard, which no git-based deploy marker can see.
  // Value is meaningless as a magnitude (each warm instance emits once): presence
  // in a period = the config changed in that period.
  RFQ_CONFIG_CHANGED = 'RFQ_CONFIG_CHANGED',

  // Metrics for circuit breaker
  CIRCUIT_BREAKER_V2_CONSECUTIVE_BLOCKS = 'CIRCUIT_BREAKER_V2_CONSECUTIVE_BLOCKS',
  // Per-filler Laplace-smoothed fade rate over the post-block window (compare to FADE_RATE_BLOCK_THRESHOLD)
  CIRCUIT_BREAKER_V2_FADE_RATE = 'CIRCUIT_BREAKER_V2_FADE_RATE',
  // Per-filler Laplace-smoothed fade rate over the in-flight-during-block cohort, emitted while
  // a filler is benched. This is the rate that drives extend/re-block decisions, so it (not the
  // post-block FADE_RATE, which sits at the prior while blocked) is what shows a benched filler
  // above the threshold. Compare to FADE_RATE_BLOCK_THRESHOLD.
  CIRCUIT_BREAKER_V2_DURING_BLOCK_RATE = 'CIRCUIT_BREAKER_V2_DURING_BLOCK_RATE',
  // Per-filler RAW (unsmoothed) fade rate over the query window's FINAL rows (past the
  // streak finality horizon, so not-yet-loaded fills can't chart as transient fades),
  // ignoring the clean-slate floor — the no-amnesty "chronic" view. Watchlist only, never a
  // block trigger: it exists to surface persistent moderate faders who live inside the block
  // threshold's small-sample envelope (e.g. ~20% raw at ~15 orders/day). Emitted only at a
  // minimum sample size (CHRONIC_RATE_MIN_SAMPLE) and rate floor (CHRONIC_RATE_EMISSION_FLOOR)
  // so per-filler series exist only for watch-worthy fillers.
  CIRCUIT_BREAKER_V2_CHRONIC_RATE = 'CIRCUIT_BREAKER_V2_CHRONIC_RATE',
  // Filler addresses whose latest-N query window has outrun the streak finality horizon this
  // run (window full AND its oldest row fresher than STREAK_FINALITY_LAG_SECS): rows for
  // these addresses are evicted before they can be streak-classified, thinning decay credit.
  // Merely sitting at the latest-N cap is the designed adaptive window and does not count.
  // Sustained nonzero values mean per-address volume has outgrown the window parameters.
  CIRCUIT_BREAKER_V2_SATURATED_ADDRESSES = 'CIRCUIT_BREAKER_V2_SATURATED_ADDRESSES',
  // Fillers newly blocked in a cron run (unblocked -> blocked)
  CIRCUIT_BREAKER_V2_NEW_BLOCKS = 'CIRCUIT_BREAKER_V2_NEW_BLOCKS',
  // Active blocks extended in a cron run (in-flight cohort faded over threshold while blocked)
  CIRCUIT_BREAKER_V2_EXTENDED_BLOCKS = 'CIRCUIT_BREAKER_V2_EXTENDED_BLOCKS',
  // Fillers currently benched (blockUntilTimestamp in the future) after a cron run
  CIRCUIT_BREAKER_V2_ACTIVE_BLOCKS = 'CIRCUIT_BREAKER_V2_ACTIVE_BLOCKS',
  // Fillers with fade stats evaluated in a cron run (sample-health denominator)
  CIRCUIT_BREAKER_V2_FILLERS_EVALUATED = 'CIRCUIT_BREAKER_V2_FILLERS_EVALUATED',
}

type MetricNeedingContext =
  | Metric.RFQ_REQUESTED
  | Metric.RFQ_SUCCESS
  | Metric.RFQ_RESPONSE_TIME
  | Metric.RFQ_FAIL_REQUEST_MATCH
  | Metric.RFQ_FAIL_VALIDATION
  | Metric.RFQ_NON_QUOTE
  | Metric.RFQ_FAIL_ERROR
  | Metric.RFQ_STRAGGLER
  | Metric.RFQ_TIMEOUT
  | Metric.CIRCUIT_BREAKER_V2_CONSECUTIVE_BLOCKS
  | Metric.CIRCUIT_BREAKER_V2_FADE_RATE
  | Metric.CIRCUIT_BREAKER_V2_DURING_BLOCK_RATE
  | Metric.CIRCUIT_BREAKER_V2_CHRONIC_RATE;

export function metricContext(metric: MetricNeedingContext, context: string): string {
  return `${metric}_${context}`;
}
