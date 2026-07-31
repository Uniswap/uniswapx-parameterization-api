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
      y: 0,
      x: 0,
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
      y: 22,
      x: 0,
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
        y: 22,
        x: 0,
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
    x: 0,
    y: 32,
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
      y: 22,
      x: 11,
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
        widgets: [
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
