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
      horizontal: {
        label?: string;
        value: number;
      }[];
    };
  };
};

const RFQ_SERVICES = [SoftQuoteMetricDimension, HardQuoteMetricDimension];

const chainLabel = (chainId: ChainId): string => `${ChainId[chainId]} (${chainId})`;

// ---------------------------------------------------------------------------
// Latency story + attribution rows.
//
// Frozen pre-optimization baseline for the story row: measured from the combined
// (dimensionless) QUOTE_E2E_LATENCY stream over its first 26h in prod
// (2026-08-04 → 2026-08-05, 4.19M samples). Deliberately NOT updated when latency
// improves — the widening gap between the live series and these lines is the
// dashboard's point. If the metric's semantics ever change, remeasure and rename
// the label, don't silently re-baseline.
// ---------------------------------------------------------------------------
export const BASELINE_E2E_P50_MS = 568;
export const BASELINE_E2E_P90_MS = 592;
// Mirrors the p90 QUOTE_LATENCY alarm threshold in api-stack.ts (not imported: the
// alarm is defined inline there). Shown for context on the per-service widgets.
const LATENCY_ALARM_THRESHOLD_MS = 2_000;
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

/** Row 0: the story — combined latency vs the frozen Aug 2026 baseline, plus stat tiles. */
export const StoryRowWidgets = (region: string): LambdaWidget[] => [
  {
    height: 8,
    width: 12,
    type: 'metric',
    properties: {
      metrics: [
        combined(Metric.QUOTE_E2E_LATENCY, { stat: 'p50', label: 'p50', color: PERCENTILE_COLORS.p50 }),
        combined(Metric.QUOTE_E2E_LATENCY, { stat: 'p90', label: 'p90', color: PERCENTILE_COLORS.p90 }),
        combined(Metric.QUOTE_E2E_LATENCY, { stat: 'p99', label: 'p99', color: PERCENTILE_COLORS.p99 }),
      ],
      view: 'timeSeries',
      stacked: false,
      region,
      period: 300,
      title: 'Quote Latency, all services — vs Aug 2026 baseline',
      yAxis: { left: { label: 'ms', showUnits: false } },
      annotations: {
        horizontal: [
          { label: `Aug 2026 baseline p50 (${BASELINE_E2E_P50_MS}ms)`, value: BASELINE_E2E_P50_MS },
          { label: `Aug 2026 baseline p90 (${BASELINE_E2E_P90_MS}ms)`, value: BASELINE_E2E_P90_MS },
        ],
      },
    },
  },
  {
    height: 4,
    width: 6,
    type: 'metric',
    properties: {
      metrics: [combined(Metric.QUOTE_E2E_LATENCY, { stat: 'p50', label: 'p50 now (1h)' })],
      view: 'singleValue',
      sparkline: true,
      stacked: false,
      region,
      period: 3600,
      title: 'Quote latency p50',
    },
  },
  {
    height: 4,
    width: 6,
    type: 'metric',
    properties: {
      metrics: [combined(Metric.QUOTE_E2E_LATENCY, { stat: 'p90', label: 'p90 now (1h)' })],
      view: 'singleValue',
      sparkline: true,
      stacked: false,
      region,
      period: 3600,
      title: 'Quote latency p90',
    },
  },
  {
    height: 4,
    width: 6,
    type: 'metric',
    properties: {
      metrics: [
        [
          {
            expression: `100*(${BASELINE_E2E_P50_MS}-p50now)/${BASELINE_E2E_P50_MS}`,
            label: '% faster than Aug 2026 baseline (p50)',
            id: 'pctFaster',
            region,
          },
        ],
        combined(Metric.QUOTE_E2E_LATENCY, { stat: 'p50', id: 'p50now', visible: false }),
      ],
      view: 'singleValue',
      sparkline: true,
      stacked: false,
      region,
      period: 3600,
      title: '% faster than baseline',
    },
  },
  {
    height: 4,
    width: 6,
    type: 'metric',
    properties: {
      // (baseline − p50)ms × requests → hours: /1000 (s) /3600 (h) = /3_600_000
      metrics: [
        [
          {
            expression: `(${BASELINE_E2E_P50_MS}-dailyP50)*dailyRequests/3600000`,
            label: 'swapper-hours of waiting eliminated per day',
            id: 'hoursSaved',
            region,
          },
        ],
        combined(Metric.QUOTE_E2E_LATENCY, { stat: 'p50', id: 'dailyP50', visible: false }),
        combined(Metric.QUOTE_REQUESTED, { stat: 'Sum', id: 'dailyRequests', visible: false }),
      ],
      view: 'singleValue',
      sparkline: false,
      stacked: false,
      region,
      period: 86400,
      title: 'Swapper-hours saved / day',
    },
  },
];

/** Row 1: where the time goes — per-service E2E percentiles and the phase decomposition. */
export const PhaseDecompositionWidgets = (region: string): LambdaWidget[] =>
  RFQ_SERVICES.flatMap((service) => [
    {
      height: 8,
      width: 12,
      type: 'metric',
      properties: {
        metrics: [
          [
            'Uniswap',
            Metric.QUOTE_E2E_LATENCY,
            'Service',
            service.Service,
            { stat: 'p50', label: 'p50', color: PERCENTILE_COLORS.p50 },
          ],
          [
            'Uniswap',
            Metric.QUOTE_E2E_LATENCY,
            'Service',
            service.Service,
            { stat: 'p90', label: 'p90', color: PERCENTILE_COLORS.p90 },
          ],
          [
            'Uniswap',
            Metric.QUOTE_E2E_LATENCY,
            'Service',
            service.Service,
            { stat: 'p99', label: 'p99', color: PERCENTILE_COLORS.p99 },
          ],
        ],
        view: 'timeSeries',
        stacked: false,
        region,
        period: 300,
        title: `${service.Service} E2E Latency (all response codes) | 5 minutes`,
        yAxis: { left: { label: 'ms', showUnits: false } },
        annotations: {
          horizontal: [
            { label: 'webhook timeout', value: WEBHOOK_TIMEOUT_MS },
            { label: 'p90 alarm threshold', value: LATENCY_ALARM_THRESHOLD_MS },
          ],
        },
      },
    },
    {
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
        period: 300,
        title: `${service.Service} Phase decomposition p50 (stacked) | 5 minutes`,
        yAxis: { left: { label: 'ms', showUnits: false } },
      },
    },
  ]);

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
      title: 'Wasted wait after last usable quote | 5 minutes',
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
      title: 'Fan-out straggler (set the wall) by filler | 5 minutes',
    },
  },
];

/** Row 3: per-chain views of the new latency metrics. */
export const E2EByChainWidgets = (region: string): LambdaWidget[] =>
  RFQ_SERVICES.map((service) => {
    return {
      height: 8,
      width: 12,
      type: 'metric',
      properties: {
        metrics: SUPPORTED_CHAINS.map((chainId) => [
          'Uniswap',
          Metric.QUOTE_E2E_LATENCY,
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
        title: `${service.Service} E2E Latency p90 by Chain | 5 minutes`,
      },
    };
  });

export const FanoutByChainWidgets = (region: string): LambdaWidget[] =>
  RFQ_SERVICES.map((service) => {
    return {
      height: 8,
      width: 12,
      type: 'metric',
      properties: {
        metrics: SUPPORTED_CHAINS.map((chainId) => [
          'Uniswap',
          Metric.RFQ_PHASE_FANOUT,
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
        title: `${service.Service} Fan-out wall p90 by Chain | 5 minutes`,
      },
    };
  });

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

    new aws_cloudwatch.CfnDashboard(this, 'UniswapXParamDashboard', {
      dashboardName: `UniswapXParamDashboard`,
      dashboardBody: JSON.stringify({
        periodOverride: 'inherit',
        // Default to a 3-month window: the point of the top rows is the long-run
        // downward staircase, not the last hour.
        start: '-P3M',
        // Widgets auto-flow in array order (no explicit x/y): story row first,
        // attribution rows next, the pre-existing ops widgets after.
        widgets: [
          StoryRowWidgets(region),
          PhaseDecompositionWidgets(region),
          WastedWaitWidgets(region),
          E2EByChainWidgets(region),
          FanoutByChainWidgets(region),
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
      }),
    });
  }
}
