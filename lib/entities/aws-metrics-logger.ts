import { IMetric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import { MetricsLogger as AWSEmbeddedMetricsLogger } from 'aws-embedded-metrics';

export const UniswapXParamServiceMetricDimension = {
  Service: 'UniswapXParameterizationAPI',
};

export const UniswapXParamServiceIntegrationMetricDimension = {
  Service: 'UniswapXParameterizationAPI-Integration',
};

export const SyntheticSwitchMetricDimension = {
  Service: 'SyntheticSwitch',
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

  public putDimensions(dimensions: Record<string, string>): void {
    this.awsMetricLogger.putDimensions(dimensions);
  }

  public putMetric(key: string, value: number, unit?: MetricLoggerUnit): void {
    this.awsMetricLogger.putMetric(key, value, unit);
  }
}

export enum Metric {
  QUOTE_200 = 'QUOTE_200',
  QUOTE_400 = 'QUOTE_400',
  QUOTE_404 = 'QUOTE_404',
  QUOTE_500 = 'QUOTE_500',

  QUOTE_REQUESTED = 'QUOTE_REQUESTED',
  QUOTE_LATENCY = 'QUOTE_LATENCY',
  QUOTE_RESPONSE_COUNT = 'QUOTE_RESPONSE_COUNT',

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

  // Metrics for synth switch cron
  DYNAMO_REQUEST = 'DYNAMO_REQUEST',
  DYNAMO_REQUEST_ERROR = 'DYNAMO_REQUEST_ERROR',
  SYTH_PAIR_ENABLED = 'SYTH_PAIR_ENABLED',
  SYNTH_PAIR_DISABLED = 'SYNTH_PAIR_DISABLED',
  SYNTH_ORDERS = 'SYTH_ORDERS',
  SYNTH_ORDERS_PROCESSING_TIME = 'SYNTH_ORDERS_PROCESSING_TIME',
  SYNTH_ORDERS_VIEW_CREATION_TIME = 'SYNTH_ORDERS_VIEW_CREATION_TIME',
  SYNTH_ORDERS_QUERY_TIME = 'SYNTH_ORDERS_QUERY_TIME',
  SYNTH_ORDERS_POSITIVE_OUTCOME = 'SYNTH_ORDERS_POSITIVE_OUTCOME',
  SYNTH_ORDERS_NEGATIVE_OUTCOME = 'SYNTH_ORDERS_NEGATIVE_OUTCOME',

  // Metrics for circuit breaker
  CIRCUIT_BREAKER_V2_BLOCKED = 'CIRCUIT_BREAKER_V2_BLOCKED',
  CIRCUIT_BREAKER_TRIGGERED = 'CIRCUIT_BREAKER_TRIGGERED',
}

type MetricNeedingContext =
  | Metric.RFQ_REQUESTED
  | Metric.RFQ_SUCCESS
  | Metric.RFQ_RESPONSE_TIME
  | Metric.RFQ_FAIL_REQUEST_MATCH
  | Metric.RFQ_FAIL_VALIDATION
  | Metric.RFQ_NON_QUOTE
  | Metric.RFQ_FAIL_ERROR
  | Metric.DYNAMO_REQUEST
  | Metric.DYNAMO_REQUEST_ERROR
  | Metric.SYTH_PAIR_ENABLED
  | Metric.SYNTH_PAIR_DISABLED
  | Metric.SYNTH_ORDERS_POSITIVE_OUTCOME
  | Metric.SYNTH_ORDERS_NEGATIVE_OUTCOME;

export function metricContext(metric: MetricNeedingContext, context: string): string {
  return `${metric}_${context}`;
}
