import { IMetric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import { MetricsLogger as AWSEmbeddedMetricsLogger } from 'aws-embedded-metrics';

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

  QUOTE_REQUESTED = 'QUOTE_REQUESTED',
  QUOTE_LATENCY = 'QUOTE_LATENCY',
  QUOTE_RESPONSE_COUNT = 'QUOTE_RESPONSE_COUNT',

  RFQ_REQUESTED = 'RFQ_REQUESTED',
  RFQ_SUCCESS = 'RFQ_SUCCESS',
  RFQ_RESPONSE_TIME = 'RFQ_RESPONSE_TIME',
  RFQ_FAIL_REQUEST_MATCH = 'RFQ_FAIL_REQUEST_MATCH',
  RFQ_NON_QUOTE = 'RFQ_NON_QUOTE',
  RFQ_FAIL_VALIDATION = 'RFQ_FAIL_VALIDATION',
  RFQ_FAIL_ERROR = 'RFQ_FAIL_ERROR',
}

type MetricNeedingContext =
  | Metric.RFQ_REQUESTED
  | Metric.RFQ_SUCCESS
  | Metric.RFQ_RESPONSE_TIME
  | Metric.RFQ_FAIL_REQUEST_MATCH
  | Metric.RFQ_FAIL_VALIDATION
  | Metric.RFQ_NON_QUOTE
  | Metric.RFQ_FAIL_ERROR;

export function metricContext(metric: MetricNeedingContext, context: string): string {
  return `${metric}_${context}`;
}
