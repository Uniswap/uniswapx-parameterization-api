import * as cdk from 'aws-cdk-lib';
import * as aws_cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { LambdaWidget } from './param-dashboard-stack';
import { Metric, SyntheticSwitchMetricDimension, metricContext } from '../../lib/entities';

const PERIOD = 15 * 60;

const OrdersQueryExecutionTime = (region: string): LambdaWidget => ({
  height: 11,
  width: 24,
  y: 0,
  x: 0,
  type: 'metric',
  properties: {
    metrics: [
      ['Uniswap', Metric.SYNTH_ORDERS_QUERY_TIME, 'Service', SyntheticSwitchMetricDimension.Service]
    ],
    view: 'timeSeries',
    region,
    stat: 'p90',
    period: PERIOD,
    stacked: false,
    title: 'Orders Query Execution Time',
  },
});

const OrdersFetchedWidget = (region: string): LambdaWidget => ({
  height: 11,
  width: 24,
  y: 0,
  x: 0,
  type: 'metric',
  properties: {
    metrics: [
      ['Uniswap', Metric.SYNTH_ORDERS, 'Service', SyntheticSwitchMetricDimension.Service]
    ],
    view: 'timeSeries',
    region,
    stat: 'Sum',
    period: PERIOD,
    stacked: false,
    title: 'Quotes Requested | 5 minutes',
  },
});

const DynamoErrorRateWidget = (region: string): LambdaWidget => ({
  height: 11,
  width: 24,
  y: 0,
  x: 0,
  type: 'metric',
  properties: {
    metrics: [
      [
        {
          expression: `100*(m1/m2)`,
          id: `e1`,
          region,
        },
      ],
      ['Uniswap', Metric.DYNAMO_REQUEST_ERROR, 'Service', SyntheticSwitchMetricDimension.Service, {
        label: 'DynamoDB Error Rate',
        id: 'm1',
        visible: false
      }],
      ['Uniswap', Metric.DYNAMO_REQUEST, 'Service', SyntheticSwitchMetricDimension.Service, {
        label: 'DynamoDB Request Count',
        id: 'm2',
        visible: false
      }],
    ],
    view: 'timeSeries',
    region,
    stat: 'Sum',
    period: PERIOD,
    stacked: false,
    title: 'DynamoDB Error Rate',
    yAxis: {
      left: {
        label: 'Percent',
        showUnits: false,
      },
    },
  },
});

const DynamoErrorRateOrdersQueryWidget = (region: string): LambdaWidget => ({
  height: 11,
  width: 24,
  y: 0,
  x: 0,
  type: 'metric',
  properties: {
    metrics: [
      ['Uniswap', metricContext(Metric.DYNAMO_REQUEST_ERROR, 'orders_network'), 'Service', SyntheticSwitchMetricDimension.Service],
      ['Uniswap', metricContext(Metric.DYNAMO_REQUEST_ERROR, 'orders_status'), 'Service', SyntheticSwitchMetricDimension.Service],
      ['Uniswap', metricContext(Metric.DYNAMO_REQUEST_ERROR, 'orders_unknown'), 'Service', SyntheticSwitchMetricDimension.Service],
    ],
    view: 'timeSeries',
    region,
    stat: 'Sum',
    period: PERIOD,
    stacked: false,
    title: 'DynamoDB Orders Query Error Rate Breakdown',
    yAxis: {
      left: {
        label: 'Percent',
        showUnits: false,
      },
    },
  },
});

const OrdersOutcomeWidget = (region: string): LambdaWidget => ({
  height: 11,
  width: 24,
  y: 0,
  x: 0,
  type: 'metric',
  properties: {
    metrics: [
      ['Uniswap', Metric.SYNTH_ORDERS_POSITIVE_OUTCOME, 'Service', SyntheticSwitchMetricDimension.Service],
      ['Uniswap', Metric.SYNTH_ORDERS_NEGATIVE_OUTCOME, 'Service', SyntheticSwitchMetricDimension.Service],
    ],
    view: 'timeSeries',
    region,
    stat: 'Sum',
    period: PERIOD,
    stacked: true,
    title: 'Orders Outcome',
  },
});


export class CronDashboardStack extends cdk.NestedStack {
  constructor(scope: Construct, name: string, props: cdk.NestedStackProps) {
    super(scope, name, props);

    const region = cdk.Stack.of(this).region;

    new aws_cloudwatch.CfnDashboard(this, 'UniswapXCronDashboard', {
      dashboardName: `UniswapXCronDashboard`,
      dashboardBody: JSON.stringify({
        periodOverride: 'inherit',
        widgets: [
          OrdersFetchedWidget(region),
          OrdersQueryExecutionTime(region),
          DynamoErrorRateWidget(region),
          DynamoErrorRateOrdersQueryWidget(region),
          OrdersOutcomeWidget(region),
        ],
      }),
    });
  }
}
