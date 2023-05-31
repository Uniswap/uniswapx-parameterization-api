import * as cdk from 'aws-cdk-lib'
import * as aws_cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import { Construct } from 'constructs'
import { STAGE } from '../../lib/util/stage';

export const NAMESPACE = 'Uniswap'

export type MetricPath = string | { expression?: string, visible?: boolean, id?: string, label?: string, region?: string };

export type LambdaWidget = {
  type: string
  x: number
  y: number
  width: number
  height: number
  properties: {
    view: string;
    stacked: boolean;
    period?: number;
    metrics?: MetricPath[][];
    region: string;
    title: string;
    stat?: string,
    query?: string,
    yAxis?: {
      left: {
        label: string,
        showUnits: boolean
      }
    }
  },
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
      [ "Uniswap", "RFQ_RESPONSE_TIME_https://rfq.fullblock.space/gouda-rfqs", "Service", "GoudaParameterizationAPI", { label: "Flow Traders" } ],
      [ ".", "RFQ_RESPONSE_TIME_http://gouda-test-dev.us-west-2.elasticbeanstalk.com", ".", ".", { label: "Ergonia" } ],
      [ ".", "RFQ_RESPONSE_TIME_https://swap.symbolic.markets/gouda/quote", ".", ".", { label: "SCP" } ],
      [ ".", "RFQ_RESPONSE_TIME_https://kehr54rr.altono.xyz/uniswap/gouda/quote", ".", ".", { label: "Altonomy" } ],
      [ ".", "RFQ_RESPONSE_TIME_https://api.prycto.network/kELxupuoRRWdKX9Q1inVoxOkuNvc3BsHvKTkEYQZ/gouda/defi/quote", ".", ".", { label: "Prycto" } ],
      [ ".", "RFQ_RESPONSE_TIME_https://pdtmm.ambergroup.io/uniswap-gouda/", ".", ".", { label: "Amber" } ],
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
      [ { expression: "100*(m2/m4)", label: "200", id: "e1", region } ],
      [ { expression: "100*(m3/m4)", label: "404", id: "e2", region } ],
      [ "Uniswap", "QUOTE_200", "Service", "GoudaParameterizationAPI", { id: "m2", visible: false } ],
      [ ".", "QUOTE_404", ".", ".", { id: "m3", visible: false } ],
      [ ".", "QUOTE_REQUESTED", ".", ".", { id: "m4", visible: false } ]
    ],
    view: "timeSeries",
    stacked: true,
    region,
    stat: "Sum",
    period: 300,
    title: "Error Rates",
    yAxis: {
      left: {
        label: "Percent",
        showUnits: false
      }
    }
  }
})

const FailingRFQLogsWidget = (region: string, stage: string): LambdaWidget => {
  const logGroup = stage === STAGE.BETA ?
  '/aws/lambda/beta-us-east-2-GoudaParameterization-QuoteE2906A56-dD269KqZUBHo' :
  '/aws/lambda/prod-us-east-2-GoudaParameterization-QuoteE2906A56-glqABjbF8MQv';

  return {
    type: "log",
    x: 0,
    y: 32,
    width: 24,
    height: 6,
    properties: {
      query: `SOURCE '${logGroup}' | fields @timestamp, msg\n| filter quoter = 'WebhookQuoter' and msg like \"Error fetching quote\"\n| sort @timestamp desc\n| limit 20`,
      region,
      stacked: false,
      view: "table",
      title: "Failing RFQ Logs"
    }
  };
}

const RFQFailRatesWidget = (region: string): LambdaWidget => ({
  height: 10,
  width: 13,
  y: 22,
  x: 11,
  type: "metric",
  properties: {
    metrics: [
      [ { expression: "100*((m2+m3)/m1)", label: "Flow Traders", id: "e1", region } ],
      [ { expression: "100*((m5+m6)/m4)", label: "Ergonia", id: "e2", region } ],
      [ { expression: "100*((m8+m9)/m7)", label: "Prycto", id: "e3", region } ],
      [ "Uniswap", "RFQ_REQUESTED_https://rfq.fullblock.space/gouda-rfqs", "Service", "GoudaParameterizationAPI", { id: "m1", visible: false } ],
      [ ".", "RFQ_FAIL_ERROR_https://rfq.fullblock.space/gouda-rfqs", ".", ".", { id: "m2", visible: false } ],
      [ ".", "RFQ_FAIL_VALIDATION_https://rfq.fullblock.space/gouda-rfqs", ".", ".", { id: "m3", visible: false } ],
      [ ".", "RFQ_REQUESTED_http://gouda-test-dev.us-west-2.elasticbeanstalk.com", ".", ".", { id: "m4", visible: false } ],
      [ ".", "RFQ_FAIL_ERROR_http://gouda-test-dev.us-west-2.elasticbeanstalk.com", ".", ".", { id: "m5", visible: false } ],
      [ ".", "RFQ_FAIL_VALIDATION_http://gouda-test-dev.us-west-2.elasticbeanstalk.com", ".", ".", { id: "m6", visible: false } ],
      [ ".", "RFQ_REQUESTED_https://api.prycto.network/kELxupuoRRWdKX9Q1inVoxOkuNvc3BsHvKTkEYQZ/gouda/defi/quote", ".", ".", { id: "m7", visible: false } ],
      [ ".", "RFQ_FAIL_ERROR_https://api.prycto.network/kELxupuoRRWdKX9Q1inVoxOkuNvc3BsHvKTkEYQZ/gouda/defi/quote", ".", ".", { id: "m8", visible: false } ],
      [ ".", "RFQ_FAIL_VALIDATION_https://api.prycto.network/kELxupuoRRWdKX9Q1inVoxOkuNvc3BsHvKTkEYQZ/gouda/defi/quote", ".", ".", { id: "m9", visible: false } ],
    ],
    view: "timeSeries",
    stacked: false,
    region,
    stat: "Sum",
    period: 300,
    title: "RFQ Fail Rates",
    yAxis: {
      left: {
        label: "Percent",
        showUnits: false
      }
    }
  }
})

export interface DashboardProps extends cdk.NestedStackProps {
  stage: string;
}

export class ParamDashboardStack extends cdk.NestedStack {
  constructor(scope: Construct, name: string, props: DashboardProps) {
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
          FailingRFQLogsWidget(region, props.stage),
        ],
      }),
    })
  }
}
