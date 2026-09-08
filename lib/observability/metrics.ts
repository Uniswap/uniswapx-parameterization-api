/** Outcome tag, reserved so success/failure is spelled one way across every metric. */
export type MetricStatus = 'success' | 'failure';

/**
 * Why a `failure` fired. A closed set — extend the enum rather than passing an ad-hoc string —
 * so a per-reason breakdown stays enumerable on a dashboard. Grounded in the request path's
 * existing failure exits: no RFQ quote came back; the swapper's order failed validation
 * (unknown cosigner, deadline too close); a dependency timed out; a dependency refused the
 * request (order-service 4xx, a FillerAddress claim owned by another endpoint); a dependency
 * failed (order-service 5xx, a DynamoDB error).
 */
export enum MetricReason {
  NoQuotes = 'no_quotes',
  Validation = 'validation',
  Timeout = 'timeout',
  Rejected = 'rejected',
  Upstream = 'upstream',
}

/**
 * StatsD/Datadog-style tags. `status` and `reason` are reserved with fixed vocabularies; any
 * other key is free-form. The EMF adapter drops tags (see EmfMetrics for why); the StatsD sink
 * that replaces it on ECS honours them.
 */
export interface MetricTags {
  status?: MetricStatus;
  reason?: MetricReason;
  [tag: string]: string | undefined;
}

/**
 * The metrics surface the request path depends on, shaped like a StatsD/Datadog client so the
 * sink can change without touching call sites. The three kinds are exactly the EMF units the
 * handlers emit today (see EmfMetrics): increment -> Count, histogram -> Milliseconds,
 * gauge -> None.
 */
export interface Metrics {
  /** Count an occurrence; `value` defaults to 1. */
  increment(name: string, value?: number, tags?: MetricTags): void;
  /** Record a point-in-time level (unitless). */
  gauge(name: string, value: number, tags?: MetricTags): void;
  /** Record a duration, in milliseconds. */
  histogram(name: string, value: number, tags?: MetricTags): void;
}
