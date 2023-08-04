import * as cdk from 'aws-cdk-lib';
import * as aws_cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export const NAMESPACE = 'Uniswap';

export type MetricPath =
  | string
  | { expression?: string; visible?: boolean; id?: string; label?: string; region?: string };

export type LambdaWidget = {
  type: string;
  x: number;
  y: number;
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
  };
};

const LatencyWidget = (region: string): LambdaWidget => ({
  height: 11,
  width: 11,
  y: 11,
  x: 0,
  type: 'metric',
  properties: {
    metrics: [['Uniswap', 'QUOTE_LATENCY', 'Service', 'UniswapXParameterizationAPI']],
    view: 'timeSeries',
    stacked: false,
    region,
    stat: 'p90',
    period: 300,
    title: 'Latency P90 | 5 minutes',
  },
});

const RFQLatencyWidget = (region: string, rfqProviders: string[]): LambdaWidget => ({
  height: 11,
  width: 13,
  y: 11,
  x: 11,
  type: 'metric',
  properties: {
    metrics: rfqProviders.map((name) => [
      'Uniswap',
      `RFQ_RESPONSE_TIME_${name}`,
      'Service',
      'UniswapXParameterizationAPI',
      { label: name },
    ]),
    view: 'timeSeries',
    stacked: false,
    region,
    stat: 'p90',
    period: 300,
    title: 'RFQ Response Times P90 | 5 minutes',
  },
});

const QuotesRequestedWidget = (region: string): LambdaWidget => ({
  height: 11,
  width: 24,
  y: 0,
  x: 0,
  type: 'metric',
  properties: {
    metrics: [
      ['Uniswap', 'QUOTE_REQUESTED', 'Service', 'UniswapXParameterizationAPI'],
      ['.', 'QUOTE_200', '.', '.', { visible: false }],
    ],
    view: 'timeSeries',
    region,
    stat: 'Sum',
    period: 300,
    stacked: false,
    title: 'Quotes Requested | 5 minutes',
  },
});

const ErrorRatesWidget = (region: string): LambdaWidget => ({
  height: 10,
  width: 11,
  y: 22,
  x: 0,
  type: 'metric',
  properties: {
    metrics: [
      [{ expression: '100*(m2/m4)', label: '200', id: 'e1', region }],
      [{ expression: '100*(m3/m4)', label: '404', id: 'e2', region }],
      ['Uniswap', 'QUOTE_200', 'Service', 'UniswapXParameterizationAPI', { id: 'm2', visible: false }],
      ['.', 'QUOTE_404', '.', '.', { id: 'm3', visible: false }],
      ['.', 'QUOTE_REQUESTED', '.', '.', { id: 'm4', visible: false }],
    ],
    view: 'timeSeries',
    stacked: true,
    region,
    stat: 'Sum',
    period: 300,
    title: 'Error Rates',
    yAxis: {
      left: {
        label: 'Percent',
        showUnits: false,
      },
    },
  },
});

const FailingRFQLogsWidget = (region: string, logGroup: string): LambdaWidget => {
  return {
    type: 'log',
    x: 0,
    y: 32,
    width: 24,
    height: 6,
    properties: {
      query: `SOURCE '${logGroup}' | fields @timestamp, msg\n| filter quoter = 'WebhookQuoter' and msg like \"Error fetching quote\"\n| sort @timestamp desc\n| limit 20`,
      region,
      stacked: false,
      view: 'table',
      title: 'Failing RFQ Logs',
    },
  };
};

const RFQFailRatesWidget = (region: string, rfqProviders: string[]): LambdaWidget => ({
  height: 10,
  width: 13,
  y: 22,
  x: 11,
  type: 'metric',
  properties: {
    metrics: rfqProviders.flatMap((name, i) => {
      const rfqRequested = i * 3;
      const rfqFailError = i * 3 + 1;
      const rfqFailValidation = i * 3 + 2;
      return [
        [
          {
            expression: `100*((m${rfqFailError}+m${rfqFailValidation})/m${rfqRequested})`,
            label: name,
            id: `e${i}`,
            region,
          },
        ],
        [
          'Uniswap',
          `RFQ_REQUESTED_${name}`,
          'Service',
          'UniswapXParameterizationAPI',
          { id: `m${rfqRequested}`, visible: false },
        ],
        [
          'Uniswap',
          `RFQ_FAIl_ERROR_${name}`,
          'Service',
          'UniswapXParameterizationAPI',
          { id: `m${rfqFailError}`, visible: false },
        ],
        [
          'Uniswap',
          `RFQ_FAIL_VALIDATION_${name}`,
          'Service',
          'UniswapXParameterizationAPI',
          { id: `m${rfqFailValidation}`, visible: false },
        ],
      ];
    }),
    view: 'timeSeries',
    stacked: false,
    region,
    stat: 'Sum',
    period: 300,
    title: 'RFQ Fail Rates',
    yAxis: {
      left: {
        label: 'Percent',
        showUnits: false,
      },
    },
  },
});

export interface DashboardProps extends cdk.NestedStackProps {
  quoteLambda: aws_lambda_nodejs.NodejsFunction;
}

// TODO: fetch dynamically from s3?
const RFQ_PROVIDERS = ['A', 'B', 'C', 'D', 'E', 'F'];

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
          RFQLatencyWidget(region, RFQ_PROVIDERS),
          QuotesRequestedWidget(region),
          ErrorRatesWidget(region),
          RFQFailRatesWidget(region, RFQ_PROVIDERS),
          FailingRFQLogsWidget(region, props.quoteLambda.logGroup.logGroupArn),
        ],
      }),
    });
  }
}
