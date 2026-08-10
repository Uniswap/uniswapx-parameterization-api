import * as cdk from 'aws-cdk-lib';
import * as aws_cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

import { FADE_RATE_BLOCK_THRESHOLD } from '../../lib/cron/fade-rate-v2';
import {
  CircuitBreakerMetricDimension,
  HardQuoteMetricDimension,
  Metric,
  SoftQuoteMetricDimension,
} from '../../lib/entities';
import { ChainId, SUPPORTED_CHAINS } from '../../lib/util/chains';
import { deployMarkers, MILESTONES, VerticalAnnotation } from './deploy-markers';

export type MetricPath =
  | string
  | {
      expression?: string;
      visible?: boolean;
      id?: string;
      label?: string;
      region?: string;
      stat?: string;
      color?: string;
      period?: number;
    };

export type LambdaWidget = {
  type: string;
  x?: number;
  y?: number;
  width: number;
  height: number;
  properties: {
    view: string;
    stacked: boolean;
    period?: number;
    metrics?: MetricPath[][];
    region: string;
    title: string;
    stat?: string;
    query?: string;
    sparkline?: boolean;
    yAxis?: {
      left: {
        label: string;
        showUnits: boolean;
      };
    };
    annotations?: {
      horizontal?: {
        label?: string;
        value: number;
      }[];
      vertical?: {
        label?: string;
        value: string; // ISO 8601 timestamp
      }[];
    };
  };
};

const RFQ_SERVICES = [SoftQuoteMetricDimension, HardQuoteMetricDimension];

const chainLabel = (chainId: ChainId): string => `${ChainId[chainId]} (${chainId})`;

// ---------------------------------------------------------------------------
// Latency story + attribution rows.
//
// Frozen pre-optimization baseline for the story row: measured from the
// Service=SoftQuote QUOTE_E2E_LATENCY stream over its first days in prod
// (2026-08-04T16:00Z onward). Soft-only on purpose: hard-quote latency includes
// cosigning and the order post to uniswapx-service, a different pipeline on
// ~0.06% of volume. Deliberately NOT updated when latency improves — the widening
// gap between the live series and these lines is the dashboard's point. If the
// metric's semantics ever change, remeasure and rename the label, don't silently
// re-baseline.
//
// METHOD (must match how the graphs render, or the line sits visibly off the
// data): each baseline is the MEAN OF PER-BUCKET PERCENTILES at that graph's
// period (5-minute buckets for soft, 1-hour for hard) — the same statistic the
// timeSeries widgets plot. A percentile pooled over the whole window is NOT
// comparable: pooling weights every request equally, so high-volume/fast periods
// pull it below the per-bucket line the eye compares against (pooled soft p50
// measured 568 vs bucket-mean 575).
// ---------------------------------------------------------------------------
// Measured 2026-08-06 over 2026-08-04T16:00Z → 2026-08-06T22:00Z (594 buckets).
export const BASELINE_E2E_P50_MS = 575;
export const BASELINE_E2E_P90_MS = 597;
export const BASELINE_E2E_P99_MS = 703;
// Hard-quote baselines, same window and method at 1-hour buckets (hard is ~80
// requests/hour, so 5-minute percentiles would be single-digit-sample noise; its
// p99 in particular is the shakiest number here — ~the worst request per bucket).
// The hard pipeline additionally spans cosigning (KMS) and the order post.
export const BASELINE_HARD_E2E_P50_MS = 868;
export const BASELINE_HARD_E2E_P90_MS = 1168;
export const BASELINE_HARD_E2E_P99_MS = 1779;
// Per-chain webhook (RFQ) timeout — the fan-out latency floor (see lib/constants.ts).
const WEBHOOK_TIMEOUT_MS = 500;

// Latency percentiles are one measure at three depths: a single-hue ramp, darker =
// deeper percentile. Phases are three identities: first three categorical slots in
// emission order. Wasted wait is the number this dashboard exists to drive down: red.
const PERCENTILE_COLORS = { p50: '#6da7ec', p90: '#2a78d6', p99: '#104281' };
const PHASE_COLORS = { statuses: '#2a78d6', compliance: '#eb6834', fanout: '#1baf7a' };
const WASTED_WAIT_COLORS = { p50: '#e34948', p90: '#d03b3b' };

// A metric path with NO dimension name/value pairs addresses the dimensionless
// rollup streams (soft+hard combined) that the shared quote injector emits.
const combined = (metricName: string, opts: Exclude<MetricPath, string>): MetricPath[] => ['Uniswap', metricName, opts];

/**
 * Stamps event markers (this-repo deploys from git, plus hand-kept milestones) as
 * vertical annotations on every time-series widget, so latency steps line up with
 * the change that caused them. Non-graph widgets (tiles, logs) pass through.
 */
export const withEventMarkers = (widgets: LambdaWidget[], markers: VerticalAnnotation[]): LambdaWidget[] =>
  markers.length === 0
    ? widgets
    : widgets.map((w) =>
        w.properties.view === 'timeSeries'
          ? {
              ...w,
              properties: {
                ...w.properties,
                annotations: {
                  ...w.properties.annotations,
                  vertical: [...(w.properties.annotations?.vertical ?? []), ...markers],
                },
              },
            }
          : w
      );

/**
 * Config-repo changes leave no trace in this repo's git history, so they get their
 * own marker source: the RFQ_CONFIG_CHANGED metric, emitted by the webhook config
 * provider whenever a refresh observes a different filler config. Rendered as a
 * thin strip on the same time axis as the story graphs above it — presence of a
 * spike means "the config changed here"; its height is just warm-instance count.
 */
const ConfigChangeStripWidget = (region: string): LambdaWidget => ({
  height: 3,
  width: 24,
  type: 'metric',
  properties: {
    // Two emission streams: quote lambdas publish through the request logger
    // (dimensionless rollup), the fade-rate cron through its CircuitBreaker-
    // dimensioned logger. Chart both so a change observed only by the cron
    // still paints a spike.
    metrics: [
      combined(Metric.RFQ_CONFIG_CHANGED, { stat: 'Sum', label: 'observed by quote lambdas' }),
      [
        'Uniswap',
        Metric.RFQ_CONFIG_CHANGED,
        'Service',
        CircuitBreakerMetricDimension.Service,
        { stat: 'Sum', label: 'observed by circuit-breaker cron' },
      ],
    ],
    view: 'timeSeries',
    stacked: false,
    region,
    period: 300,
    title: 'RFQ config changes observed (spike = filler config changed; height is not meaningful)',
  },
});

/**
 * The exact moment traffic shifted to each Lambda version — the precise complement
 * to the git-derived markers, whose timestamps are merge time (~15-30 min before
 * serving). Version numbers map to commits by lining a version's first-traffic
 * time up with the nearest deploy marker (deliberately no per-version commit
 * stamping: that would force a provisioned-concurrency re-warm on every merge).
 */
const InvocationsByVersionWidget = (region: string, quoteLambdaFunctionName: string): LambdaWidget => ({
  height: 6,
  width: 24,
  type: 'metric',
  properties: {
    metrics: [
      [
        {
          expression: `SEARCH('{AWS/Lambda,FunctionName,Resource,ExecutedVersion} FunctionName="${quoteLambdaFunctionName}" MetricName="Invocations"', 'Sum', 300)`,
          id: 'invocationsByVersion',
          region,
        },
      ],
    ],
    view: 'timeSeries',
    stacked: true,
    region,
    period: 300,
    title: 'Soft quote invocations by Lambda version (exact deploy traffic-shift moments)',
  },
});

// Per-service metric path builders. Soft and hard are charted separately: hard-quote
// latency includes cosigning and the order post, a structurally different pipeline.
const serviceMetric =
  (service: string) =>
  (metricName: string, opts: Exclude<MetricPath, string>): MetricPath[] =>
    ['Uniswap', metricName, 'Service', service, opts];
const soft = serviceMetric(SoftQuoteMetricDimension.Service);
const hard = serviceMetric(HardQuoteMetricDimension.Service);

// One graph per percentile so the p99 scale doesn't flatten p50/p90 against their
// baselines. Period varies by service: hard quote is ~80 requests/hour, so it charts
// hourly; 5-minute hard percentiles would be single-digit-sample noise.
const percentileStoryGraphs = (
  region: string,
  titlePrefix: string,
  metricPath: (metricName: string, opts: Exclude<MetricPath, string>) => MetricPath[],
  baselines: { p50: number; p90: number; p99: number },
  period: number
): LambdaWidget[] =>
  (
    [
      { stat: 'p50', baseline: baselines.p50, color: PERCENTILE_COLORS.p50 },
      { stat: 'p90', baseline: baselines.p90, color: PERCENTILE_COLORS.p90 },
      { stat: 'p99', baseline: baselines.p99, color: PERCENTILE_COLORS.p99 },
    ] as const
  ).map(({ stat, baseline, color }) => ({
    height: 7,
    width: 8,
    type: 'metric',
    properties: {
      metrics: [metricPath(Metric.QUOTE_E2E_LATENCY, { stat, label: stat, color })],
      view: 'timeSeries',
      stacked: false,
      region,
      period,
      title: `${titlePrefix} ${stat} — vs Aug 2026 baseline`,
      yAxis: { left: { label: 'ms', showUnits: false } },
      annotations: {
        horizontal: [{ label: `Aug 2026 baseline ${stat} (${baseline}ms)`, value: baseline }],
      },
    },
  }));

// ---------------------------------------------------------------------------
// Story rows. Layout contract: widgets in the same conceptual row have identical
// heights and widths summing to 24, so CloudWatch auto-flow renders them as one
// even row. Every title says Soft or Hard explicitly.
// ---------------------------------------------------------------------------

const pctFasterTile = (
  region: string,
  label: 'Soft' | 'Hard',
  metricPath: typeof soft,
  baseline: number,
  period: number
): LambdaWidget => ({
  height: 4,
  width: 12,
  type: 'metric',
  properties: {
    metrics: [
      [
        {
          expression: `100*(${baseline}-cur${label})/${baseline}`,
          label: '%',
          id: `pctFaster${label}`,
          region,
        },
      ],
      metricPath(Metric.QUOTE_E2E_LATENCY, { stat: 'p50', id: `cur${label}`, visible: false }),
    ],
    view: 'singleValue',
    sparkline: true,
    stacked: false,
    region,
    period,
    title: `${label} e2e — % faster than Aug 2026 baseline (p50)`,
  },
});

const latencyTile = (
  region: string,
  label: 'Soft' | 'Hard',
  metricPath: typeof soft,
  stat: 'p50' | 'p90' | 'p99',
  period: number
): LambdaWidget => ({
  height: 4,
  width: 8,
  type: 'metric',
  properties: {
    metrics: [metricPath(Metric.QUOTE_E2E_LATENCY, { stat, label: stat })],
    view: 'singleValue',
    sparkline: true,
    stacked: false,
    region,
    period,
    title: `${label} e2e ${stat} (${period === 3600 ? '1h' : '6h'})`,
  },
});

/** Rows 3+5: percentile graphs with frozen baselines (exported for tests). */
export const SoftPercentileGraphs = (region: string): LambdaWidget[] =>
  percentileStoryGraphs(
    region,
    'Soft e2e Latency',
    soft,
    { p50: BASELINE_E2E_P50_MS, p90: BASELINE_E2E_P90_MS, p99: BASELINE_E2E_P99_MS },
    300
  );

export const HardPercentileGraphs = (region: string): LambdaWidget[] =>
  percentileStoryGraphs(
    region,
    'Hard e2e Latency (incl. cosign + order post)',
    hard,
    { p50: BASELINE_HARD_E2E_P50_MS, p90: BASELINE_HARD_E2E_P90_MS, p99: BASELINE_HARD_E2E_P99_MS },
    3600
  );

/**
 * The story rows, in the agreed order:
 *   row 1: Soft %-faster | Hard %-faster
 *   row 2: swapper-hours saved/day | swapper-hours saved cumulative
 *   row 3: Soft e2e p50/p90/p99 graphs vs baselines
 *   row 4: Soft e2e p50/p90/p99 number tiles
 *   row 5: Hard e2e p50/p90/p99 graphs vs baselines
 *   row 6: Hard e2e p50/p90/p99 number tiles
 */
export const LatencyStoryRows = (region: string): LambdaWidget[] => [
  // row 1
  pctFasterTile(region, 'Soft', soft, BASELINE_E2E_P50_MS, 3600),
  pctFasterTile(region, 'Hard', hard, BASELINE_HARD_E2E_P50_MS, 21600),
  // row 2 — (baseline − p50)ms × requests → hours: /1000 (s) /3600 (h) = /3_600_000
  {
    height: 4,
    width: 12,
    type: 'metric',
    properties: {
      metrics: [
        [
          {
            expression: `(${BASELINE_E2E_P50_MS}-dailyP50)*dailyRequests/3600000`,
            label: 'hours',
            id: 'hoursSaved',
            region,
          },
        ],
        soft(Metric.QUOTE_E2E_LATENCY, { stat: 'p50', id: 'dailyP50', visible: false }),
        soft(Metric.QUOTE_REQUESTED, { stat: 'Sum', id: 'dailyRequests', visible: false }),
      ],
      view: 'singleValue',
      sparkline: false,
      stacked: false,
      region,
      period: 86400,
      title: 'Soft — swapper-hours of waiting eliminated / day',
    },
  },
  {
    height: 4,
    width: 12,
    type: 'metric',
    properties: {
      // RUNNING_SUM accumulates the per-day savings; singleValue shows the latest
      // point, i.e. the cumulative total over the displayed dashboard window.
      metrics: [
        [
          {
            expression: `RUNNING_SUM((${BASELINE_E2E_P50_MS}-cumP50)*cumRequests/3600000)`,
            label: 'hours',
            id: 'hoursSavedTotal',
            region,
          },
        ],
        soft(Metric.QUOTE_E2E_LATENCY, { stat: 'p50', id: 'cumP50', visible: false }),
        soft(Metric.QUOTE_REQUESTED, { stat: 'Sum', id: 'cumRequests', visible: false }),
      ],
      view: 'singleValue',
      sparkline: true,
      stacked: false,
      region,
      period: 86400,
      title: 'Soft — swapper-hours saved, total over displayed window',
    },
  },
  // row 3
  ...SoftPercentileGraphs(region),
  // row 4
  latencyTile(region, 'Soft', soft, 'p50', 3600),
  latencyTile(region, 'Soft', soft, 'p90', 3600),
  latencyTile(region, 'Soft', soft, 'p99', 3600),
  // row 5
  ...HardPercentileGraphs(region),
  // row 6
  latencyTile(region, 'Hard', hard, 'p50', 21600),
  latencyTile(region, 'Hard', hard, 'p90', 21600),
  latencyTile(region, 'Hard', hard, 'p99', 21600),
];

/**
 * Row 7: soft vs hard phase decomposition p50, side by side. The per-service E2E
 * percentile graphs that used to live here are covered by the story rows above.
 * Note the hard chart decomposes only the shared RFQ phases — cosigning and the
 * order post are not individually instrumented yet, so they show up as the gap
 * between this stack and the Hard e2e graphs.
 */
export const PhaseDecompositionWidgets = (region: string): LambdaWidget[] =>
  RFQ_SERVICES.map((service) => {
    const isHard = service.Service === HardQuoteMetricDimension.Service;
    const label = isHard ? 'Hard' : 'Soft';
    return {
      height: 8,
      width: 12,
      type: 'metric',
      properties: {
        metrics: [
          [
            'Uniswap',
            Metric.RFQ_PHASE_ENDPOINT_STATUSES,
            'Service',
            service.Service,
            { stat: 'p50', label: 'endpoint statuses (S3+Dynamo)', color: PHASE_COLORS.statuses },
          ],
          [
            'Uniswap',
            Metric.RFQ_PHASE_COMPLIANCE,
            'Service',
            service.Service,
            { stat: 'p50', label: 'compliance', color: PHASE_COLORS.compliance },
          ],
          [
            'Uniswap',
            Metric.RFQ_PHASE_FANOUT,
            'Service',
            service.Service,
            { stat: 'p50', label: 'webhook fan-out', color: PHASE_COLORS.fanout },
          ],
        ],
        view: 'timeSeries',
        stacked: true,
        region,
        period: isHard ? 3600 : 300,
        title: isHard
          ? `${label} phase decomposition p50 (RFQ phases only; excl. cosign + order post)`
          : `${label} phase decomposition p50 (stacked) | 5 minutes`,
        yAxis: { left: { label: 'ms', showUnits: false } },
      },
    };
  });

/** Row 2: who is costing every swapper the wait — wasted wait, timeouts, stragglers. */
export const WastedWaitWidgets = (region: string): LambdaWidget[] => [
  {
    height: 8,
    width: 8,
    type: 'metric',
    properties: {
      metrics: [
        combined(Metric.RFQ_WASTED_WAIT, { stat: 'p50', label: 'p50', color: WASTED_WAIT_COLORS.p50 }),
        combined(Metric.RFQ_WASTED_WAIT, { stat: 'p90', label: 'p90', color: WASTED_WAIT_COLORS.p90 }),
      ],
      view: 'timeSeries',
      stacked: false,
      region,
      period: 300,
      // "Straggler tax": the fan-out holds the response open after the last usable
      // quote has arrived, waiting on stragglers ("The Tail at Scale" terminology).
      title: 'Straggler tax (soft+hard) — wait after last usable quote | 5 minutes',
      yAxis: { left: { label: 'ms', showUnits: false } },
      annotations: {
        horizontal: [{ label: 'webhook timeout', value: WEBHOOK_TIMEOUT_MS }],
      },
    },
  },
  {
    height: 8,
    width: 8,
    type: 'metric',
    properties: {
      // Namespace-only SEARCH schema ({Uniswap}) matches only dimensionless streams,
      // i.e. the soft+hard rollup. Token matching ignores the trailing underscore
      // (verified against the live API), so the bare total must be excluded explicitly.
      metrics: [
        [
          {
            expression: `SEARCH('{Uniswap} ${Metric.RFQ_TIMEOUT}_ NOT MetricName="${Metric.RFQ_TIMEOUT}"', 'Sum', 300)`,
            id: 'timeoutsByFiller',
            region,
          },
        ],
      ],
      view: 'timeSeries',
      stacked: false,
      region,
      period: 300,
      title: 'Webhook timeouts by filler (soft+hard) | 5 minutes',
    },
  },
  {
    height: 8,
    width: 8,
    type: 'metric',
    properties: {
      metrics: [
        [
          {
            expression: `SEARCH('{Uniswap} ${Metric.RFQ_STRAGGLER}_ NOT MetricName="${Metric.RFQ_STRAGGLER}"', 'Sum', 300)`,
            id: 'stragglersByFiller',
            region,
          },
        ],
      ],
      view: 'timeSeries',
      stacked: false,
      region,
      period: 300,
      title: 'Fan-out straggler by filler (soft+hard) | 5 minutes',
    },
  },
];

/**
 * Row 3: per-chain views of the new latency metrics. Chains are discovered via
 * SEARCH rather than mapped from SUPPORTED_CHAINS: the service is *deployable* on
 * 18 chains but RFQ traffic only actually flows on a handful (7 as of Aug 2026),
 * and which ones is decided by the runtime S3 filler config, not by any code
 * constant. SEARCH shows exactly the chains with data and picks up new ones with
 * no deploy — the tradeoff is legend labels are raw ChainId values, not names.
 */
const byChainSearchWidget = (
  region: string,
  service: string,
  metricName: string,
  title: string,
  id: string
): LambdaWidget => ({
  height: 8,
  width: 12,
  type: 'metric',
  properties: {
    metrics: [
      [
        {
          expression: `SEARCH('{Uniswap,Service,ChainId} Service="${service}" MetricName="${metricName}"', 'p90', 300)`,
          id,
          region,
        },
      ],
    ],
    view: 'timeSeries',
    stacked: false,
    region,
    period: 300,
    title,
  },
});

export const E2EByChainWidgets = (region: string): LambdaWidget[] =>
  RFQ_SERVICES.map((service) =>
    byChainSearchWidget(
      region,
      service.Service,
      Metric.QUOTE_E2E_LATENCY,
      `${service.Service} E2E Latency p90 by Chain (active chains only) | 5 minutes`,
      'e2eByChain'
    )
  );

export const FanoutByChainWidgets = (region: string): LambdaWidget[] =>
  RFQ_SERVICES.map((service) =>
    byChainSearchWidget(
      region,
      service.Service,
      Metric.RFQ_PHASE_FANOUT,
      `${service.Service} Fan-out wall p90 by Chain (active chains only) | 5 minutes`,
      'fanoutByChain'
    )
  );

const LatencyWidget = (region: string): LambdaWidget[] =>
  RFQ_SERVICES.map((service) => {
    return {
      height: 11,
      width: 11,
      type: 'metric',
      properties: {
        metrics: [
          ['Uniswap', 'QUOTE_LATENCY', 'Service', service.Service, { stat: 'p90', label: 'p90' }],
          ['Uniswap', 'QUOTE_LATENCY', 'Service', service.Service, { stat: 'p99', label: 'p99' }],
          ['Uniswap', 'QUOTE_LATENCY', 'Service', service.Service, { stat: 'p50', label: 'p50' }],
        ],
        view: 'timeSeries',
        stacked: false,
        region,
        period: 300,
        title: `${service.Service} Quote Latency | 5 minutes`,
      },
    };
  });

// Per-filler response times, discovered via SEARCH rather than a hardcoded filler list: the
// filler set lives in the S3 RFQ config and is only known at runtime, so any list baked in here
// would be wrong. Series are named RFQ_RESPONSE_TIME_<filler name> (see WebhookQuoter).
const RFQLatencyWidget = (region: string): LambdaWidget[] =>
  RFQ_SERVICES.map((service) => {
    return {
      height: 11,
      width: 13,
      type: 'metric',
      properties: {
        metrics: [
          [
            {
              expression: `SEARCH('{Uniswap,Service} Service="${service.Service}" ${Metric.RFQ_RESPONSE_TIME}_', 'p90', 300)`,
              id: 'rfqResponseTimes',
              region,
            },
          ],
        ],
        view: 'timeSeries',
        stacked: false,
        region,
        period: 300,
        title: `${service.Service} RFQ Response Times P90 | 5 minutes`,
      },
    };
  });

const QuotesRequestedWidget = (region: string): LambdaWidget[] =>
  RFQ_SERVICES.map((service) => {
    return {
      height: 11,
      width: 24,
      type: 'metric',
      properties: {
        metrics: [['Uniswap', Metric.QUOTE_REQUESTED, 'Service', service.Service]],
        view: 'timeSeries',
        region,
        stat: 'Sum',
        period: 300,
        stacked: false,
        title: `${service.Service} Quotes Requested | 5 minutes`,
      },
    };
  });

const LatencyByChainWidget = (region: string): LambdaWidget[] =>
  RFQ_SERVICES.map((service) => {
    return {
      height: 11,
      width: 12,
      type: 'metric',
      properties: {
        metrics: SUPPORTED_CHAINS.map((chainId) => [
          'Uniswap',
          'QUOTE_LATENCY',
          'Service',
          service.Service,
          'ChainId',
          chainId.toString(),
          { stat: 'p90', label: chainLabel(chainId) },
        ]),
        view: 'timeSeries',
        stacked: false,
        region,
        period: 300,
        title: `${service.Service} Quote Latency p90 by Chain | 5 minutes`,
      },
    };
  });

const QuotesRequestedByChainWidget = (region: string): LambdaWidget[] =>
  RFQ_SERVICES.map((service) => {
    return {
      height: 11,
      width: 12,
      type: 'metric',
      properties: {
        metrics: SUPPORTED_CHAINS.map((chainId) => [
          'Uniswap',
          'QUOTE_REQUESTED',
          'Service',
          service.Service,
          'ChainId',
          chainId.toString(),
          { label: chainLabel(chainId) },
        ]),
        view: 'timeSeries',
        stacked: false,
        region,
        stat: 'Sum',
        period: 300,
        title: `${service.Service} Quotes Requested by Chain | 5 minutes`,
      },
    };
  });

const ErrorRatesByChainWidget = (region: string): LambdaWidget[] =>
  RFQ_SERVICES.map((service) => {
    return {
      height: 10,
      width: 12,
      type: 'metric',
      properties: {
        metrics: SUPPORTED_CHAINS.flatMap((chainId, i) => [
          [{ expression: `100*(notfound${i}/requested${i})`, label: chainLabel(chainId), id: `e${i}`, region }],
          [
            'Uniswap',
            'QUOTE_404',
            'Service',
            service.Service,
            'ChainId',
            chainId.toString(),
            { id: `notfound${i}`, visible: false },
          ],
          [
            'Uniswap',
            'QUOTE_REQUESTED',
            'Service',
            service.Service,
            'ChainId',
            chainId.toString(),
            { id: `requested${i}`, visible: false },
          ],
        ]),
        view: 'timeSeries',
        stacked: false,
        region,
        stat: 'Sum',
        period: 300,
        title: `${service.Service} 404 Rates by Chain`,
        yAxis: {
          left: {
            label: 'Percent',
            showUnits: false,
          },
        },
      },
    };
  });

const ErrorRatesWidget = (region: string): LambdaWidget[] =>
  RFQ_SERVICES.map((service) => {
    return {
      height: 10,
      width: 11,
      type: 'metric',
      properties: {
        metrics: [
          [{ expression: '100*(m2/m4)', label: '200', id: 'e1', region }],
          [{ expression: '100*(m3/m4)', label: '404', id: 'e2', region }],
          ['Uniswap', 'QUOTE_200', 'Service', service.Service, { id: 'm2', visible: false }],
          ['.', 'QUOTE_404', '.', '.', { id: 'm3', visible: false }],
          ['.', 'QUOTE_REQUESTED', '.', '.', { id: 'm4', visible: false }],
        ],
        view: 'timeSeries',
        stacked: true,
        region,
        stat: 'Sum',
        period: 300,
        title: `${service.Service} Error Rates`,
        yAxis: {
          left: {
            label: 'Percent',
            showUnits: false,
          },
        },
      },
    };
  });

const LambdaErrorRatesWidget = (region: string, scope: Construct): LambdaWidget[] =>
  scope.node.children
    .filter((service) => service instanceof lambda.Function)
    .map((service) => {
      return {
        height: 10,
        width: 11,
        type: 'metric',
        properties: {
          metrics: [
            [
              'AWS/Lambda',
              'Errors',
              'FunctionName',
              (service as lambda.Function).functionName,
              { id: 'errors', stat: 'Sum', color: '#d13212', region: region },
            ],
            ['.', 'Invocations', '.', '.', { id: 'invocations', stat: 'Sum', visible: false, region: region }],
            [
              {
                expression: '100 - 100 * errors / MAX([errors, invocations])',
                label: 'Success rate (%)',
                id: 'availability',
                yAxis: 'right',
                region: region,
              },
            ],
          ],
          view: 'timeSeries',
          stacked: true,
          region,
          stat: 'Sum',
          period: 300,
          title: `${(service as lambda.Function).functionName} Error Rates`,
          yAxis: {
            left: {
              label: 'Percent',
              showUnits: false,
            },
          },
        },
      };
    });

const FailingRFQLogsWidget = (region: string, logGroup: string): LambdaWidget => {
  return {
    type: 'log',
    width: 24,
    height: 6,
    properties: {
      // Insights treats "double quotes" as a field reference, so the old `msg like "..."` matched
      // nothing at all. The regex needs an inline (?i) flag (Insights rejects a trailing /i) to
      // catch both WebhookQuoter branches, which differ only in case: 'Error fetching quote from'
      // and 'Axios error fetching quote from'.
      query: `SOURCE '${logGroup}' | fields @timestamp, msg\n| filter quoter = 'WebhookQuoter' and msg like /(?i)error fetching quote from/\n| sort @timestamp desc\n| limit 20`,
      region,
      stacked: false,
      view: 'table',
      title: 'Failing RFQ Logs',
    },
  };
};

// Aggregate fail rate across all fillers. WebhookQuoter emits each of these metrics in both bare
// and per-filler (`_<name>`) form on the same code path, so summing the per-filler series is
// arithmetically identical to the bare series — using the bare ones keeps this to one expression
// and, because the names come from the enum, it cannot drift from the emitter. Per-filler
// breakdown is deliberately not charted here: pairing three metric families per filler is not
// expressible via SEARCH, and per-filler latency is already visible in RFQLatencyWidget.
const RFQFailRatesWidget = (region: string): LambdaWidget[] =>
  RFQ_SERVICES.map((service) => {
    return {
      height: 10,
      width: 13,
      type: 'metric',
      properties: {
        metrics: [
          [
            {
              expression: '100*((mFailError+mFailValidation)/mRequested)',
              label: 'fail rate',
              id: 'failRate',
              region,
            },
          ],
          ['Uniswap', Metric.RFQ_REQUESTED, 'Service', service.Service, { id: 'mRequested', visible: false }],
          ['Uniswap', Metric.RFQ_FAIL_ERROR, 'Service', service.Service, { id: 'mFailError', visible: false }],
          [
            'Uniswap',
            Metric.RFQ_FAIL_VALIDATION,
            'Service',
            service.Service,
            { id: 'mFailValidation', visible: false },
          ],
        ],
        view: 'timeSeries',
        stacked: false,
        region,
        stat: 'Sum',
        period: 300,
        title: `${service.Service} RFQ Fail Rates`,
        yAxis: {
          left: {
            label: 'Percent',
            showUnits: false,
          },
        },
      },
    };
  });

const CircuitBreakerWidgets = (region: string): LambdaWidget[] => [
  // How often the breaker fires: new blocks / extensions per run, fillers currently benched,
  // and how many fillers were evaluated (sample-health denominator).
  {
    height: 8,
    width: 12,
    type: 'metric',
    properties: {
      metrics: [
        [
          'Uniswap',
          Metric.CIRCUIT_BREAKER_V2_NEW_BLOCKS,
          'Service',
          CircuitBreakerMetricDimension.Service,
          { stat: 'Sum', label: 'new blocks' },
        ],
        ['.', Metric.CIRCUIT_BREAKER_V2_EXTENDED_BLOCKS, '.', '.', { stat: 'Sum', label: 'extended blocks' }],
        ['.', Metric.CIRCUIT_BREAKER_V2_ACTIVE_BLOCKS, '.', '.', { stat: 'Maximum', label: 'active blocks' }],
        ['.', Metric.CIRCUIT_BREAKER_V2_FILLERS_EVALUATED, '.', '.', { stat: 'Maximum', label: 'fillers evaluated' }],
      ],
      view: 'timeSeries',
      stacked: false,
      region,
      period: 600,
      title: 'Circuit Breaker Activity | 10 minutes',
    },
  },
  // Per-filler smoothed fade rates against the block threshold: healthy fillers should sit
  // near the 5% prior; anyone trending toward the 12% line is about to be benched. The
  // during-block rate is charted alongside because a benched filler's post-block fade rate
  // sits at the prior — the during-block rate is what shows them above the threshold.
  {
    height: 8,
    width: 12,
    type: 'metric',
    properties: {
      metrics: [
        [
          {
            expression: `SEARCH('{Uniswap,Service} Service="${CircuitBreakerMetricDimension.Service}" ${Metric.CIRCUIT_BREAKER_V2_FADE_RATE}_', 'Average', 600)`,
            id: 'fadeRates',
            region,
          },
        ],
        [
          {
            expression: `SEARCH('{Uniswap,Service} Service="${CircuitBreakerMetricDimension.Service}" ${Metric.CIRCUIT_BREAKER_V2_DURING_BLOCK_RATE}_', 'Average', 600)`,
            id: 'duringBlockRates',
            region,
          },
        ],
      ],
      view: 'timeSeries',
      stacked: false,
      region,
      period: 600,
      title: 'Filler Fade Rates (smoothed) vs Block Threshold',
      yAxis: {
        left: {
          label: 'fade rate',
          showUnits: false,
        },
      },
      annotations: {
        horizontal: [{ label: 'block threshold', value: FADE_RATE_BLOCK_THRESHOLD }],
      },
    },
  },
  // Escalation state per filler: repeat offenders climb, recovered fillers decay back to 0.
  {
    height: 8,
    width: 12,
    type: 'metric',
    properties: {
      metrics: [
        [
          {
            expression: `SEARCH('{Uniswap,Service} Service="${CircuitBreakerMetricDimension.Service}" ${Metric.CIRCUIT_BREAKER_V2_CONSECUTIVE_BLOCKS}_', 'Maximum', 600)`,
            id: 'consecutiveBlocks',
            region,
          },
        ],
      ],
      view: 'timeSeries',
      stacked: false,
      region,
      period: 600,
      title: 'Filler Consecutive Blocks (escalation)',
    },
  },
];

export interface DashboardProps extends cdk.NestedStackProps {
  quoteLambda: aws_lambda_nodejs.NodejsFunction;
}

// TODO: fetch dynamically from s3?
export class ParamDashboardStack extends cdk.NestedStack {
  constructor(scope: Construct, name: string, props: DashboardProps) {
    super(scope, name, props);

    const region = cdk.Stack.of(this).region;

    // Markers are copied into every widget they annotate; the dashboard body has a
    // hard 100KB PutDashboard limit (an unbounded regime measured ~122KB). They
    // therefore go ONLY on the attribution graphs — story rows, phase
    // decomposition, straggler tax — never the ops widgets, and both the marker
    // count and label length are capped in deploy-markers.ts.
    const eventMarkers = [...MILESTONES, ...deployMarkers()];

    const dashboardBody = JSON.stringify({
      periodOverride: 'inherit',
      // Default to a 3-month window: the point of the top rows is the long-run
      // downward staircase, not the last hour.
      start: '-P3M',
      // Widgets auto-flow in array order (no explicit x/y): story rows first,
      // attribution rows next, the pre-existing ops widgets after.
      widgets: [
        withEventMarkers(LatencyStoryRows(region), eventMarkers),
        [ConfigChangeStripWidget(region)],
        withEventMarkers([PhaseDecompositionWidgets(region), WastedWaitWidgets(region)].flat(), eventMarkers),
        [
          E2EByChainWidgets(region),
          FanoutByChainWidgets(region),
          InvocationsByVersionWidget(region, props.quoteLambda.functionName),
          LatencyWidget(region),
          RFQLatencyWidget(region),
          QuotesRequestedWidget(region),
          ErrorRatesWidget(region),
          LatencyByChainWidget(region),
          QuotesRequestedByChainWidget(region),
          ErrorRatesByChainWidget(region),
          RFQFailRatesWidget(region),
          LambdaErrorRatesWidget(region, scope),
          FailingRFQLogsWidget(region, props.quoteLambda.logGroup.logGroupName),
          CircuitBreakerWidgets(region),
        ].flat(),
      ].flat(),
    });

    // Fail at synth, not at deploy: PutDashboard rejects bodies over 100KB with a
    // stack-update failure. The margin absorbs CDK token expansion (function/log
    // group names serialize as short placeholders here but resolve longer).
    if (dashboardBody.length > 90_000) {
      throw new Error(
        `UniswapXParamDashboard body is ${dashboardBody.length} bytes; PutDashboard rejects >100KB. ` +
          'Trim event markers or widgets (see deploy-markers.ts caps).'
      );
    }

    new aws_cloudwatch.CfnDashboard(this, 'UniswapXParamDashboard', {
      dashboardName: `UniswapXParamDashboard`,
      dashboardBody,
    });
  }
}
