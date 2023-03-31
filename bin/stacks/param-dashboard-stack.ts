import * as cdk from 'aws-cdk-lib'
import * as aws_cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import { Construct } from 'constructs'

export const NAMESPACE = 'Uniswap'

export type MetricPath = string | { expression?: string, visible?: boolean, id?: string, label?: string };

export type LambdaWidget = {
  type: string
  x: number
  y: number
  width: number
  height: number
  properties: {
    view: string;
    stacked: boolean;
    period: number;
    metrics: MetricPath[][];
    region: string;
    title: string;
    stat: string
  }
}

const LatencyWidget = (region: string): LambdaWidget => ({
  height: 11,
  width: 11,
  y: 11,
  x: 0,
  type: "metric",
  properties: {
    metrics: [
      [ "Uniswap", "QUOTE_LATENCY", "Service", "GoudaParameterizationAPI" ]
    ],
    view: "timeSeries",
    stacked: false,
    region,
    stat: "p90",
    period: 300,
    title: "Latency P90 | 5 minutes"
  }
})

const RFQLatencyWidget = (region: string): LambdaWidget => ({
  height: 11,
  width: 13,
  y: 11,
  x: 11,
  type: "metric",
  properties: {
    metrics: [
      [ "Uniswap", "RFQ_RESPONSE_TIME_https://rfq.***REMOVED***/gouda-rfqs", "Service", "GoudaParameterizationAPI", { label: "***REMOVED*** Traders" } ]
    ],
    view: "timeSeries",
    stacked: false,
    region,
    stat: "p90",
    period: 300,
    title: "RFQ Response Times P90 | 5 minutes"
  }
})

const QuotesRequestedWidget = (region: string): LambdaWidget => ({
  height: 11,
  width: 24,
  y: 0,
  x: 0,
  type: "metric",
  properties: {
    metrics: [
      [ "Uniswap", "QUOTE_REQUESTED", "Service", "GoudaParameterizationAPI" ],
      [ ".", "QUOTE_200", ".", ".", { visible: false } ]
    ],
    view: "timeSeries",
    region,
    stat: "Sum",
    period: 300,
    stacked: false,
    title: "Quotes Requested | 5 minutes"
  }
})

const ErrorRatesWidget = (region: string): LambdaWidget => ({
  height: 10,
  width: 11,
  y: 22,
  x: 0,
  type: "metric",
  properties: {
    metrics: [
      [ { expression: "100*(m2/m1)", label: "200", id: "e1" } ],
      [ "Uniswap", "QUOTE_RESPONSE_COUNT", "Service", "GoudaParameterizationAPI", { id: "m1", visible: false } ],
      [ ".", "QUOTE_200", ".", ".", { id: "m2", visible: false } ]
    ],
    view: "timeSeries",
    stacked: false,
    region,
    stat: "Average",
    period: 300,
    title: "Error Rates"
  }
})

const RFQFailRatesWidget = (region: string): LambdaWidget => ({
  height: 10,
  width: 13,
  y: 22,
  x: 11,
  type: "metric",
  properties: {
    metrics: [
      [ { expression: "100*(m1/m2)", label: "***REMOVED*** Traders", id: "e1" } ],
      [ "Uniswap", "RFQ_FAIL_ERROR_https://rfq.***REMOVED***/gouda-rfqs", "Service", "GoudaParameterizationAPI", { id: "m1", visible: false } ],
      [ ".", "RFQ_REQUESTED_https://rfq.***REMOVED***/gouda-rfqs", ".", ".", { id: "m2", visible: false } ]
    ],
    view: "timeSeries",
    stacked: false,
    region,
    stat: "Average",
    period: 300,
    title: "RFQ Fail Rates"
  }
})

export class ParamDashboardStack extends cdk.NestedStack {
  constructor(scope: Construct, name: string, props: cdk.NestedStackProps) {
    super(scope, name, props)

    const region = cdk.Stack.of(this).region

    new aws_cloudwatch.CfnDashboard(this, 'GoudaParamDashboard', {
      dashboardName: `GoudaParamDashboard`,
      dashboardBody: JSON.stringify({
        periodOverride: 'inherit',
        widgets: [
          LatencyWidget(region),
          RFQLatencyWidget(region),
          QuotesRequestedWidget(region),
          ErrorRatesWidget(region),
          RFQFailRatesWidget(region),
        ],
      }),
    })
  }
}
