import * as cdk from 'aws-cdk-lib';
import { CfnOutput, Duration } from 'aws-cdk-lib';
import * as aws_apigateway from 'aws-cdk-lib/aws-apigateway';
import { MethodLoggingLevel } from 'aws-cdk-lib/aws-apigateway';
import * as aws_asg from 'aws-cdk-lib/aws-applicationautoscaling';
import * as aws_cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
//import * as aws_dynamo from 'aws-cdk-lib/aws-dynamodb';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import * as aws_lambda from 'aws-cdk-lib/aws-lambda';
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as aws_logs from 'aws-cdk-lib/aws-logs';
import * as aws_waf from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import * as path from 'path';

//import { QUOTES_TABLE_INDEX, QUOTES_TABLE_KEY } from '../../lib/config/dynamodb';
import { SERVICE_NAME } from '../constants';
import { AnalyticsStack } from './analytics-stack';
import { ParamDashboardStack } from './param-dashboard-stack';
import { STAGE } from '../../lib/util/stage';
import { SUPPORTED_CHAINS } from '../../lib/config/chains';
import { ChainId } from '../../lib/util/chains';
import { Metric } from '../../lib/entities';

const CHAINS_NOT_ALARMED = [
  ChainId.GÖRLI,
  ChainId.POLYGON,
]
const ALL_ALARMED_CHAINS = SUPPORTED_CHAINS.filter((c) => !CHAINS_NOT_ALARMED.includes(c));

/**
 * APIStack
 *    Sets up the API Gateway and Lambda functions for the parameterization service.
 *    The API Gateway is responsible for creating REST endpoints, each of which is integrated with a Lambda function.
 */
export class APIStack extends cdk.Stack {
  public readonly url: CfnOutput;

  constructor(
    parent: Construct,
    name: string,
    props: cdk.StackProps & {
      provisionedConcurrency: number;
      internalApiKey?: string;
      throttlingOverride?: string;
      chatbotSNSArn?: string;
      stage: string;
      envVars: Record<string, string>;
    }
  ) {
    super(parent, name, props);
    const { provisionedConcurrency, internalApiKey, stage } = props;

    /*
     *  API Gateway Initialization
     */
    const accessLogGroup = new aws_logs.LogGroup(this, `${SERVICE_NAME}APIGAccessLogs`);

    const api = new aws_apigateway.RestApi(this, `${SERVICE_NAME}`, {
      restApiName: `${SERVICE_NAME}`,
      deployOptions: {
        tracingEnabled: true,
        loggingLevel: MethodLoggingLevel.ERROR,
        accessLogDestination: new aws_apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: aws_apigateway.AccessLogFormat.jsonWithStandardFields({
          ip: false,
          caller: false,
          user: false,
          requestTime: true,
          httpMethod: true,
          resourcePath: true,
          status: true,
          protocol: true,
          responseLength: true,
        }),
      },
      defaultCorsPreflightOptions: {
        allowOrigins: aws_apigateway.Cors.ALL_ORIGINS,
        allowMethods: aws_apigateway.Cors.ALL_METHODS,
      },
    });

    const ipThrottlingACL = new aws_waf.CfnWebACL(this, `${SERVICE_NAME}IPThrottlingACL`, {
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `${SERVICE_NAME}IPBasedThrottling`,
      },
      customResponseBodies: {
        [`${SERVICE_NAME}ThrottledResponseBody`]: {
          contentType: 'APPLICATION_JSON',
          content: '{"errorCode": "TOO_MANY_REQUESTS"}',
        },
      },
      name: `${SERVICE_NAME}IPThrottling`,
      rules: [
        {
          name: 'ip',
          priority: 0,
          statement: {
            rateBasedStatement: {
              // Limit is per 5 mins, i.e. 120 requests every 5 mins
              limit: props.throttlingOverride ? parseInt(props.throttlingOverride) : 120,
              // API is of type EDGE so is fronted by Cloudfront as a proxy.
              // Use the ip set in X-Forwarded-For by Cloudfront, not the regular IP
              // which would just resolve to Cloudfronts IP.
              aggregateKeyType: 'FORWARDED_IP',
              forwardedIpConfig: {
                headerName: 'X-Forwarded-For',
                fallbackBehavior: 'MATCH',
              },
              scopeDownStatement: {
                notStatement: {
                  statement: {
                    byteMatchStatement: {
                      fieldToMatch: {
                        singleHeader: {
                          name: 'x-api-key',
                        },
                      },
                      positionalConstraint: 'EXACTLY',
                      searchString: internalApiKey,
                      textTransformations: [
                        {
                          type: 'NONE',
                          priority: 0,
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          action: {
            block: {
              customResponse: {
                responseCode: 429,
                customResponseBodyKey: `${SERVICE_NAME}ThrottledResponseBody`,
              },
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${SERVICE_NAME}IPBasedThrottlingRule`,
          },
        },
      ],
    });

    const region = cdk.Stack.of(this).region;
    const apiArn = `arn:aws:apigateway:${region}::/restapis/${api.restApiId}/stages/${api.deploymentStage.stageName}`;

    new aws_waf.CfnWebACLAssociation(this, `${SERVICE_NAME}IPThrottlingAssociation`, {
      resourceArn: apiArn,
      webAclArn: ipThrottlingACL.getAtt('Arn').toString(),
    });

    /*
     * Lambda Initialization
     */
    const lambdaRole = new aws_iam.Role(this, `$LambdaRole`, {
      assumedBy: new aws_iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonDynamoDBFullAccess'),
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess'),
      ],
    });

    const quoteLambda = new aws_lambda_nodejs.NodejsFunction(this, 'Quote', {
      role: lambdaRole,
      runtime: aws_lambda.Runtime.NODEJS_16_X,
      entry: path.join(__dirname, '../../lib/handlers/index.ts'),
      handler: 'quoteHandler',
      memorySize: 1024,
      bundling: {
        minify: true,
        sourceMap: true,
      },
      environment: {
        VERSION: '2',
        NODE_OPTIONS: '--enable-source-maps',
        ...props.envVars,
        stage
      },
      timeout: Duration.seconds(30),
    });

    const quoteLambdaAlias = new aws_lambda.Alias(this, `GetOrdersLiveAlias`, {
      aliasName: 'live',
      version: quoteLambda.currentVersion,
      provisionedConcurrentExecutions: provisionedConcurrency > 0 ? provisionedConcurrency : undefined,
    });

    const mockQuoteLambda = new aws_lambda_nodejs.NodejsFunction(this, 'mockQuote', {
      role: lambdaRole,
      runtime: aws_lambda.Runtime.NODEJS_16_X,
      entry: path.join(__dirname, '../../lib/handlers/index.ts'),
      handler: 'mockQuoteHandler',
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
      },
      environment: {
        VERSION: '2',
        NODE_OPTIONS: '--enable-source-maps',
        ...props.envVars,
        stage
      },
      timeout: Duration.seconds(15),
    });

    const mockQuoteAlias = new aws_lambda.Alias(this, `MockQuoteLiveAlias`, {
      aliasName: 'live',
      version: mockQuoteLambda.currentVersion,
      provisionedConcurrentExecutions: provisionedConcurrency > 0 ? provisionedConcurrency : undefined,
    });

    const integrationRfqLambda = new aws_lambda_nodejs.NodejsFunction(this, 'Rfq', {
      role: lambdaRole,
      runtime: aws_lambda.Runtime.NODEJS_16_X,
      entry: path.join(__dirname, '../../lib/handlers/index.ts'),
      handler: 'rfqHandler',
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
      },
      environment: {
        VERSION: '3',
        NODE_OPTIONS: '--enable-source-maps',
        ...props.envVars,
        stage
      },
      timeout: Duration.seconds(5),
    });

    const rfqLambdaAlias = new aws_lambda.Alias(this, `RfqLiveAlias`, {
      aliasName: 'live',
      version: integrationRfqLambda.currentVersion,
      provisionedConcurrentExecutions: provisionedConcurrency > 0 ? provisionedConcurrency : undefined,
    });

    if (provisionedConcurrency > 0) {
      const quoteTarget = new aws_asg.ScalableTarget(this, 'QuoteProvConcASG', {
        serviceNamespace: aws_asg.ServiceNamespace.LAMBDA,
        maxCapacity: provisionedConcurrency * 5,
        minCapacity: provisionedConcurrency,
        resourceId: `function:${quoteLambdaAlias.lambda.functionName}:${quoteLambdaAlias.aliasName}`,
        scalableDimension: 'lambda:function:ProvisionedConcurrency',
      });

      quoteTarget.node.addDependency(quoteLambdaAlias);
    }

    /*
     * APIG <> Lambda Integration
     */
    const quoteLambdaIntegration = new aws_apigateway.LambdaIntegration(quoteLambdaAlias, {});
    const quote = api.root.addResource('quote', {
      defaultCorsPreflightOptions: {
        allowOrigins: aws_apigateway.Cors.ALL_ORIGINS,
        allowMethods: aws_apigateway.Cors.ALL_METHODS,
      },
    });
    quote.addMethod('POST', quoteLambdaIntegration);

    const integration = api.root.addResource('integration', {
      defaultCorsPreflightOptions: {
        allowOrigins: aws_apigateway.Cors.ALL_ORIGINS,
        allowMethods: aws_apigateway.Cors.ALL_METHODS,
      },
    });
    const rfqLambdaIntegration = new aws_apigateway.LambdaIntegration(rfqLambdaAlias, {});
    const mockQuoteIntegration = new aws_apigateway.LambdaIntegration(mockQuoteAlias, {});
    const mockQuote = integration.addResource('quote');
    const integrationRfq = integration.addResource('rfq');
    integrationRfq.addMethod('POST', rfqLambdaIntegration);
    mockQuote.addMethod('POST', mockQuoteIntegration);
    /*
     * Param Dashboard Stack Initialization
     */
    new ParamDashboardStack(this, 'ParamDashboardStack', {
      quoteLambda,
    });

    /*
     * Analytics Stack Initialization
     */
    new AnalyticsStack(this, 'AnalyticsStack', {
      quoteLambda,
      envVars: props.envVars,
    });

    /* Alarms */
    // Mostly copied from URA
    const apiAlarm5xxSev2 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV2-5XXAlarm', {
      alarmName: 'UniswapXParameterizationAPI-SEV2-5XX',
      metric: api.metricServerError({
        period: Duration.minutes(5),
        // For this metric 'avg' represents error rate.
        statistic: 'avg',
      }),
      threshold: 0.05,
      // Beta has much less traffic so is more susceptible to transient errors.
      evaluationPeriods: stage == STAGE.BETA ? 5 : 3,
    });

    const apiAlarm5xxSev3 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV3-5XXAlarm', {
      alarmName: 'UniswapXParameterizationAPI-SEV3-5XX',
      metric: api.metricServerError({
        period: Duration.minutes(5),
        // For this metric 'avg' represents error rate.
        statistic: 'avg',
      }),
      threshold: 0.03,
      // Beta has much less traffic so is more susceptible to transient errors.
      evaluationPeriods: stage == STAGE.BETA ? 5 : 3,
    });

    const apiAlarm4xxSev2 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV2-4XXAlarm', {
      alarmName: 'UniswapXParameterizationAPI-SEV2-4XX',
      metric: api.metricClientError({
        period: Duration.minutes(5),
        statistic: 'avg',
      }),
      threshold: 0.95,
      evaluationPeriods: 3,
    });

    const apiAlarm4xxSev3 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV3-4XXAlarm', {
      alarmName: 'UniswapXParameterizationAPI-SEV3-4XX',
      metric: api.metricClientError({
        period: Duration.minutes(5),
        statistic: 'avg',
      }),
      threshold: 0.8,
      evaluationPeriods: 3,
    });

    const apiAlarmLatencySev2 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV2-Latency', {
      alarmName: 'UniswapXParameterizationAPI-SEV2-Latency',
      metric: api.metricLatency({
        period: Duration.minutes(5),
        statistic: 'p90',
      }),
      threshold: 8500,
      evaluationPeriods: 3,
    });

    const apiAlarmLatencySev3 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV3-Latency', {
      alarmName: 'UniswapXParameterizationAPI-SEV3-Latency',
      metric: api.metricLatency({
        period: Duration.minutes(5),
        statistic: 'p90',
      }),
      threshold: 5500,
      evaluationPeriods: 3,
    });

    // Alarms for 200 rate being too low for each chain
    // TODO: we don't append the chainId to metric names yet
    const percent5XXByChainAlarm: cdk.aws_cloudwatch.Alarm[] = ALL_ALARMED_CHAINS.flatMap((chainId) => {
      const alarmNameSev3 = `UniswapXParameterizationAPI-SEV3-5XXAlarm-ChainId-${chainId.toString()}`;
      const alarmNameSev2 = `UniswapXParameterizationAPI-SEV2-5XXAlarm-ChainId-${chainId.toString()}`;

      const metric = new aws_cloudwatch.MathExpression({
        expression: '100*(response5XX/invocations)',
        period: Duration.minutes(5),
        usingMetrics: {
          invocations: new aws_cloudwatch.Metric({
            namespace: 'Uniswap',
            metricName: `${Metric.QUOTE_REQUESTED}`,
            dimensionsMap: { Service: SERVICE_NAME },
            unit: aws_cloudwatch.Unit.COUNT,
            statistic: 'sum',
          }),
          response5XX: new aws_cloudwatch.Metric({
            namespace: 'Uniswap',
            metricName: `${Metric.QUOTE_500}`,
            dimensionsMap: { Service: SERVICE_NAME },
            unit: aws_cloudwatch.Unit.COUNT,
            statistic: 'sum',
          }),
        },
      });

      return [
        new aws_cloudwatch.Alarm(this, alarmNameSev2, {
          alarmName: alarmNameSev2,
          metric,
          threshold: 10,
          evaluationPeriods: 3,
        }),
        new aws_cloudwatch.Alarm(this, alarmNameSev3, {
          alarmName: alarmNameSev3,
          metric,
          threshold: 5,
          evaluationPeriods: 3,
        }),
      ];
    });

    // Alarms for 4XX rate being too high for each chain
    const percent4XXByChainAlarm: cdk.aws_cloudwatch.Alarm[] = ALL_ALARMED_CHAINS.flatMap((chainId) => {
      const alarmNameSev3 = `UniswapXParameterizationAPI-SEV3-4XXAlarm-ChainId-${chainId.toString()}`;
      const alarmNameSev2 = `UniswapXParameterizationAPI-SEV2-4XXAlarm-ChainId-${chainId.toString()}`;

      const metric = new aws_cloudwatch.MathExpression({
        expression: '100*((response400+response404)/invocations)',
        period: Duration.minutes(5),
        usingMetrics: {
          invocations: new aws_cloudwatch.Metric({
            namespace: 'Uniswap',
            metricName: `${Metric.QUOTE_REQUESTED}`,
            dimensionsMap: { Service: SERVICE_NAME },
            unit: aws_cloudwatch.Unit.COUNT,
            statistic: 'sum',
          }),
          response400: new aws_cloudwatch.Metric({
            namespace: 'Uniswap',
            metricName: `${Metric.QUOTE_400}`,
            dimensionsMap: { Service: SERVICE_NAME },
            unit: aws_cloudwatch.Unit.COUNT,
            statistic: 'sum',
          }),
          response404: new aws_cloudwatch.Metric({
            namespace: 'Uniswap',
            metricName: `${Metric.QUOTE_404}`,
            dimensionsMap: { Service: SERVICE_NAME },
            unit: aws_cloudwatch.Unit.COUNT,
            statistic: 'sum',
          }),
        },
      });

      return [
        new aws_cloudwatch.Alarm(this, alarmNameSev2, {
          alarmName: alarmNameSev2,
          metric,
          threshold: 80,
          evaluationPeriods: 3,
        }),
        new aws_cloudwatch.Alarm(this, alarmNameSev3, {
          alarmName: alarmNameSev3,
          metric,
          threshold: 50,
          evaluationPeriods: 3,
        }),
      ];
    });

    // Alarm on calls from URA to the routing API
    const routingAPIErrorMetric = new aws_cloudwatch.MathExpression({
      expression: '100*(error/invocations)',
      period: Duration.minutes(5),
      usingMetrics: {
        invocations: new aws_cloudwatch.Metric({
          namespace: 'Uniswap',
          metricName: `RoutingApiQuoterRequest`,
          dimensionsMap: { Service: SERVICE_NAME },
          unit: aws_cloudwatch.Unit.COUNT,
          statistic: 'sum',
        }),
        error: new aws_cloudwatch.Metric({
          namespace: 'Uniswap',
          metricName: `RoutingApiQuoterErr`,
          dimensionsMap: { Service: SERVICE_NAME },
          unit: aws_cloudwatch.Unit.COUNT,
          statistic: 'sum',
        }),
      },
    });

    const routingAPIErrorRateAlarmSev2 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV2-RoutingAPI-ErrorRate', {
      alarmName: 'UniswapXParameterizationAPI-SEV2-RoutingAPI-ErrorRate',
      metric: routingAPIErrorMetric,
      threshold: 10,
      evaluationPeriods: 3,
    });

    const routingAPIErrorRateAlarmSev3 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV3-RoutingAPI-ErrorRate', {
      alarmName: 'UniswapXParameterizationAPI-SEV3-RoutingAPI-ErrorRate',
      metric: routingAPIErrorMetric,
      threshold: 5,
      evaluationPeriods: 3,
    });

    // Alarm on calls from URA to the rfq service
    const rfqAPIErrorMetric = new aws_cloudwatch.MathExpression({
      expression: '100*(error/invocations)',
      period: Duration.minutes(5),
      usingMetrics: {
        invocations: new aws_cloudwatch.Metric({
          namespace: 'Uniswap',
          metricName: `RfqQuoterRequest`,
          dimensionsMap: { Service: SERVICE_NAME },
          unit: aws_cloudwatch.Unit.COUNT,
          statistic: 'sum',
        }),
        error: new aws_cloudwatch.Metric({
          namespace: 'Uniswap',
          metricName: `RfqQuoterRfqErr`,
          dimensionsMap: { Service: SERVICE_NAME },
          unit: aws_cloudwatch.Unit.COUNT,
          statistic: 'sum',
        }),
      },
    });

    const rfqAPIErrorRateAlarmSev2 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV2-RFQAPI-ErrorRate', {
      alarmName: 'UniswapXParameterizationAPI-SEV2-RFQAPI-ErrorRate',
      metric: rfqAPIErrorMetric,
      threshold: 10,
      evaluationPeriods: 3,
    });

    const rfqAPIErrorRateAlarmSev3 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV3-RFQAPI-ErrorRate', {
      alarmName: 'UniswapXParameterizationAPI-SEV3-RFQAPI-ErrorRate',
      metric: rfqAPIErrorMetric,
      threshold: 5,
      evaluationPeriods: 3,
    });

    // Alarm on calls from URA to the nonce service (uniswapx service)
    const nonceAPIErrorMetric = new aws_cloudwatch.MathExpression({
      expression: '100*(error/invocations)',
      period: Duration.minutes(5),
      usingMetrics: {
        invocations: new aws_cloudwatch.Metric({
          namespace: 'Uniswap',
          metricName: `RfqQuoterRequest`,
          dimensionsMap: { Service: SERVICE_NAME },
          unit: aws_cloudwatch.Unit.COUNT,
          statistic: 'sum',
        }),
        error: new aws_cloudwatch.Metric({
          namespace: 'Uniswap',
          metricName: `RfqQuoterNonceErr`,
          dimensionsMap: { Service: SERVICE_NAME },
          unit: aws_cloudwatch.Unit.COUNT,
          statistic: 'sum',
        }),
      },
    });

    const nonceAPIErrorRateAlarmSev2 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV2-NonceAPI-ErrorRate', {
      alarmName: 'UniswapXParameterizationAPI-SEV2-NonceAPI-ErrorRate',
      metric: nonceAPIErrorMetric,
      threshold: 10,
      evaluationPeriods: 3,
    });

    const nonceAPIErrorRateAlarmSev3 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV3-NonceAPI-ErrorRate', {
      alarmName: 'UniswapXParameterizationAPI-SEV3-NonceAPI-ErrorRate',
      metric: nonceAPIErrorMetric,
      threshold: 5,
      evaluationPeriods: 3,
    });

    if (chatbotSNSArn) {
      const chatBotTopic = cdk.aws_sns.Topic.fromTopicArn(this, 'ChatbotTopic', chatbotSNSArn);
      apiAlarm5xxSev2.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      apiAlarm4xxSev2.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      apiAlarm5xxSev3.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      apiAlarm4xxSev3.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      apiAlarmLatencySev2.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      apiAlarmLatencySev3.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));

      percent5XXByChainAlarm.forEach((alarm) => {
        alarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      });
      percent4XXByChainAlarm.forEach((alarm) => {
        alarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      });

      routingAPIErrorRateAlarmSev2.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      routingAPIErrorRateAlarmSev3.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      rfqAPIErrorRateAlarmSev2.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      rfqAPIErrorRateAlarmSev3.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      nonceAPIErrorRateAlarmSev2.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      nonceAPIErrorRateAlarmSev3.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
    }

    this.url = new CfnOutput(this, 'Url', {
      value: api.url,
    });
  }
}
