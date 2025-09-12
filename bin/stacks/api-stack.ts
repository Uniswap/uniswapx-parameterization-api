import * as cdk from 'aws-cdk-lib';
import { CfnOutput, Duration } from 'aws-cdk-lib';
import * as aws_apigateway from 'aws-cdk-lib/aws-apigateway';
import { MethodLoggingLevel } from 'aws-cdk-lib/aws-apigateway';
import * as aws_asg from 'aws-cdk-lib/aws-applicationautoscaling';
import * as aws_cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as aws_dynamo from 'aws-cdk-lib/aws-dynamodb';
import { CfnEIP, NatProvider, Vpc } from 'aws-cdk-lib/aws-ec2';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import * as aws_lambda from 'aws-cdk-lib/aws-lambda';
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as aws_logs from 'aws-cdk-lib/aws-logs';
import * as aws_waf from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import * as path from 'path';
import { KmsStack } from './kms-stack';

import { DYNAMO_TABLE_NAME } from '../../lib/constants';
import {
  HardQuoteMetricDimension,
  Metric,
  SoftQuoteMetricDimension,
  UniswapXParamServiceMetricDimension,
} from '../../lib/entities';
import { STAGE } from '../../lib/util/stage';
import { PROD_TABLE_CAPACITY } from '../config';
import { SERVICE_NAME } from '../constants';
import { AnalyticsStack } from './analytics-stack';
import { CronDashboardStack } from './cron-dashboard-stack';
import { CronStack } from './cron-stack';
import { FirehoseStack } from './firehose-stack';
import { ParamDashboardStack } from './param-dashboard-stack';

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
    const region = cdk.Stack.of(this).region;
    const { provisionedConcurrency, internalApiKey, stage, chatbotSNSArn } = props;

    /*
     *  API Gateway Initialization
     */
    const accessLogGroup = new aws_logs.LogGroup(this, `${SERVICE_NAME}APIGAccessLogs`);

    const api = new aws_apigateway.RestApi(this, `${SERVICE_NAME}`, {
      restApiName: `${SERVICE_NAME}`,
      deployOptions: {
        tracingEnabled: true,
        metricsEnabled: true,
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

    const apiArn = `arn:aws:apigateway:${region}::/restapis/${api.restApiId}/stages/${api.deploymentStage.stageName}`;

    new aws_waf.CfnWebACLAssociation(this, `${SERVICE_NAME}IPThrottlingAssociation`, {
      resourceArn: apiArn,
      webAclArn: ipThrottlingACL.getAtt('Arn').toString(),
    });

    // KMS initialization
    const kmsStack = new KmsStack(this, `${SERVICE_NAME}HardQuoteCosignerKey-1`);

    /*
     * Firehose Initialization
     */

    const firehoseStack = new FirehoseStack(this, 'FirehoseStack');

    /*
     * Lambda Initialization
     */
    const lambdaRole = new aws_iam.Role(this, `$LambdaRole`, {
      assumedBy: new aws_iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonDynamoDBFullAccess'),
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'),
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonRedshiftDataFullAccess'),
      ],
    });

    // allow lambdas to access the cosigner key
    lambdaRole.addToPolicy(
      new aws_iam.PolicyStatement({
        resources: [kmsStack.key.keyArn],
        actions: ['kms:GetPublicKey', 'kms:Sign'],
        effect: aws_iam.Effect.ALLOW,
      })
    );

    lambdaRole.addToPolicy(
      new aws_iam.PolicyStatement({
        actions: [
          'secretsmanager:GetSecretValue',
          'secretsmanager:DescribeSecret',
          'secretsmanager:ListSecretVersionIds',
          'secretsmanager:GetResourcePolicy',
          'firehose:PutRecord',
        ],
        resources: ['*'],
        effect: aws_iam.Effect.ALLOW,
      })
    );

    lambdaRole.addToPolicy(
      new aws_iam.PolicyStatement({
        actions: ['ec2:CreateNetworkInterface', 'ec2:DescribeNetworkInterfaces', 'ec2:DeleteNetworkInterface'],
        resources: ['*'],
      })
    );

    lambdaRole.addToPolicy(
      new aws_iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:GenerateDataKey'],
        resources: ['*'],
        effect: aws_iam.Effect.ALLOW,
      })
    );

    const quoteLambdaElasticIp = new CfnEIP(this, `QuoteLambdaElasticIp`, {
      domain: 'vpc',
      tags: [
        {
          key: 'Name',
          value: 'QuoteLambdaEIP',
        },
      ],
    });

    const vpc = new Vpc(this, 'QuoteLambdaVpc', {
      vpcName: 'QuoteLambdaVpc',
      natGateways: 1,
      natGatewayProvider: NatProvider.gateway({
        eipAllocationIds: [quoteLambdaElasticIp.attrAllocationId],
      }),
      maxAzs: 3,
    });

    const quoteLambda = new aws_lambda_nodejs.NodejsFunction(this, 'Quote', {
      role: lambdaRole,
      runtime: aws_lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lib/handlers/quote/exports.ts'),
      handler: 'quoteHandler',
      vpc,
      vpcSubnets: {
        subnets: [...vpc.privateSubnets],
      },
      memorySize: 2048,
      bundling: {
        minify: true,
        sourceMap: true,
      },
      environment: {
        VERSION: '5',
        NODE_OPTIONS: '--enable-source-maps',
        ...props.envVars,
        stage,
        ANALYTICS_STREAM_ARN: firehoseStack.analyticsStreamArn,
      },
      timeout: Duration.seconds(30),
    });

    const quoteLambdaAlias = new aws_lambda.Alias(this, `GetOrdersLiveAlias`, {
      aliasName: 'live',
      version: quoteLambda.currentVersion,
      provisionedConcurrentExecutions: provisionedConcurrency > 0 ? provisionedConcurrency : undefined,
    });

    const hardQuoteLambda = new aws_lambda_nodejs.NodejsFunction(this, 'HardQuote', {
      role: lambdaRole,
      runtime: aws_lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lib/handlers/hard-quote/exports.ts'),
      handler: 'hardQuoteHandler',
      vpc,
      vpcSubnets: {
        subnets: [...vpc.privateSubnets],
      },
      memorySize: 2048,
      bundling: {
        minify: true,
        sourceMap: true,
      },
      environment: {
        VERSION: '5',
        NODE_OPTIONS: '--enable-source-maps',
        REGION: region,
        KMS_KEY_ID: kmsStack.key.keyId,
        ...props.envVars,
        stage,
        ANALYTICS_STREAM_ARN: firehoseStack.analyticsStreamArn,
      },
      timeout: Duration.seconds(30),
    });

    const hardQuoteLambdaAlias = new aws_lambda.Alias(this, `HardQuoteLiveAlias`, {
      aliasName: 'live',
      version: hardQuoteLambda.currentVersion,
      provisionedConcurrentExecutions: provisionedConcurrency > 0 ? provisionedConcurrency : undefined,
    });

    const switchLambda = new aws_lambda_nodejs.NodejsFunction(this, 'Switch', {
      role: lambdaRole,
      runtime: aws_lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../../lib/handlers/synth-switch/exports.ts'),
      handler: 'switchHandler',
      memorySize: 512,
      bundling: {
        minify: true,
        sourceMap: true,
      },
      environment: {
        VERSION: '5',
        NODE_OPTIONS: '--enable-source-maps',
        ...props.envVars,
        stage,
        ANALYTICS_STREAM_ARN: firehoseStack.analyticsStreamArn,
      },
      timeout: Duration.seconds(30),
    });

    const switchLambdaAlias = new aws_lambda.Alias(this, `SwitchLiveAlias`, {
      aliasName: 'live',
      version: switchLambda.currentVersion,
      provisionedConcurrentExecutions: 0,
    });

    if (provisionedConcurrency > 0) {
      const quoteTarget = new aws_asg.ScalableTarget(this, 'QuoteProvConcASG', {
        serviceNamespace: aws_asg.ServiceNamespace.LAMBDA,
        maxCapacity: provisionedConcurrency * 10,
        minCapacity: provisionedConcurrency,
        resourceId: `function:${quoteLambdaAlias.lambda.functionName}:${quoteLambdaAlias.aliasName}`,
        scalableDimension: 'lambda:function:ProvisionedConcurrency',
      });

      quoteTarget.node.addDependency(quoteLambdaAlias);

      quoteTarget.scaleToTrackMetric('QuoteProvConcTracking', {
        targetValue: 0.7,
        predefinedMetric: aws_asg.PredefinedMetric.LAMBDA_PROVISIONED_CONCURRENCY_UTILIZATION,
      });
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

    const hardQuoteLambdaIntegration = new aws_apigateway.LambdaIntegration(hardQuoteLambdaAlias, {});
    const hardQuote = api.root.addResource('hard-quote', {
      defaultCorsPreflightOptions: {
        allowOrigins: aws_apigateway.Cors.ALL_ORIGINS,
        allowMethods: aws_apigateway.Cors.ALL_METHODS,
      },
    });

    hardQuote.addMethod('POST', hardQuoteLambdaIntegration, { 
      apiKeyRequired: false, // TODO: Set to true once Trading API has integrated 
    });

    const switchLambdaIntegration = new aws_apigateway.LambdaIntegration(switchLambdaAlias, {});
    const switchResource = api.root.addResource('synthetic-switch', {
      defaultCorsPreflightOptions: {
        allowOrigins: aws_apigateway.Cors.ALL_ORIGINS,
        allowMethods: aws_apigateway.Cors.ALL_METHODS,
      },
    });
    const enabled = switchResource.addResource('enabled');

    /* add auth keys */
    const tradingAPIKey = api.addApiKey('TradingAPIKey', {
      apiKeyName: 'tradingAPIKey',
      description: 'API Key for trading endpoints',
    });
    const devAPIKey = api.addApiKey('DevAPIKey', {
      apiKeyName: 'devAPIKey',
      description: 'API Key for development use',
    });
    const apiAuthzKey = api.addApiKey('AuthzKey');
    const plan = api.addUsagePlan('AccessPlan', {
      name: 'AccessPlan',
    });
    plan.addApiKey(apiAuthzKey);
    plan.addApiKey(tradingAPIKey);
    plan.addApiKey(devAPIKey);
    plan.addApiStage({
      stage: api.deploymentStage,
    });

    enabled.addMethod('GET', switchLambdaIntegration, { apiKeyRequired: true });

    /*
     * Param Dashboard Stack Initialization
     */
    new ParamDashboardStack(this, 'ParamDashboardStack', {
      quoteLambda,
    });

    /*
     * Analytics Stack Initialization
     */
    const analyticsStack = new AnalyticsStack(this, 'AnalyticsStack', {
      quoteLambda,
      hardQuoteLambda,
      envVars: props.envVars,
      analyticsStreamArn: firehoseStack.analyticsStreamArn,
      stage,
      chatbotSNSArn,
    });

    const cronStack = new CronStack(this, 'CronStack', {
      RsDatabase: analyticsStack.dbName,
      RsClusterIdentifier: analyticsStack.clusterId,
      RedshiftCredSecretArn: analyticsStack.credSecretArn,
      lambdaRole: lambdaRole,
      chatbotSNSArn: chatbotSNSArn,
      stage: stage,
    });

    new CronDashboardStack(this, 'CronDashboardStack', {
      synthSwitchLambdaName: cronStack.synthSwitchCronLambda.functionName,
      quoteLambdaName: quoteLambda.functionName,
    });

    /* filler addr table */
    new aws_dynamo.Table(this, `FillerAddrTable`, {
      tableName: DYNAMO_TABLE_NAME.FILLER_ADDRESS,
      partitionKey: {
        name: 'pk',
        type: aws_dynamo.AttributeType.STRING,
      },
      deletionProtection: true,
      pointInTimeRecovery: true,
      contributorInsightsEnabled: true,
      ...PROD_TABLE_CAPACITY.fillerAddress,
    });

    /* Alarms */
    const apiAlarm5xxSev2 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV2-5XXAlarm', {
      alarmName: 'UniswapXParameterizationAPI-SEV2-5XX',
      metric: api.metricServerError({
        period: Duration.minutes(5),
        // For this metric 'sum' represents error count.
        statistic: 'sum',
      }),
      threshold: 100,
      // Beta has much less traffic so is more susceptible to transient errors.
      evaluationPeriods: stage == STAGE.BETA ? 5 : 3,
    });

    const apiAlarm5xxSev3 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV3-5XXAlarm', {
      alarmName: 'UniswapXParameterizationAPI-SEV3-5XX',
      metric: api.metricServerError({
        period: Duration.minutes(5),
        // For this metric 'sum' represents error count.
        statistic: 'sum',
      }),
      threshold: 20,
      // Beta has much less traffic so is more susceptible to transient errors.
      evaluationPeriods: stage == STAGE.BETA ? 5 : 3,
    });

    const apiAlarm4xxSev3 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV3-4XXAlarm', {
      alarmName: 'UniswapXParameterizationAPI-SEV3-4XX',
      metric: api.metricClientError({
        period: Duration.minutes(5),
        statistic: 'avg',
      }),
      threshold: 0.98,
      evaluationPeriods: 3,
    });

    const apiAlarmLatencySev2 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV2-Latency', {
      alarmName: 'UniswapXParameterizationAPI-SEV2-Latency',
      metric: api.metricLatency({
        period: Duration.minutes(5),
        statistic: 'p90',
      }),
      // approx 2x WEBHOOK_TIMEOUT_MS
      threshold: 3500,
      evaluationPeriods: 3,
    });

    const apiAlarmLatencySev3 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV3-Latency', {
      alarmName: 'UniswapXParameterizationAPI-SEV3-Latency',
      metric: api.metricLatency({
        period: Duration.minutes(5),
        statistic: 'p90',
      }),
      // approx 1.5x WEBHOOK_TIMEOUT_MS
      threshold: 2000,
      evaluationPeriods: 3,
    });

    const apiAlarmLatencyP99Sev2 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV2-LatencyP99', {
      alarmName: 'UniswapXParameterizationAPI-SEV2-LatencyP99',
      metric: api.metricLatency({
        period: Duration.minutes(5),
        statistic: 'p99',
      }),
      threshold: 5000,
      evaluationPeriods: 3,
    });

    const apiAlarmLatencyP99Sev3 = new aws_cloudwatch.Alarm(this, 'UniswapXParameterizationAPI-SEV3-LatencyP99', {
      alarmName: 'UniswapXParameterizationAPI-SEV3-LatencyP99',
      metric: api.metricLatency({
        period: Duration.minutes(5),
        statistic: 'p99',
      }),
      threshold: 4000,
      evaluationPeriods: 3,
    });

    const chatBotTopic = chatbotSNSArn
      ? cdk.aws_sns.Topic.fromTopicArn(this, 'ChatbotTopic', chatbotSNSArn)
      : undefined;
    /* custom metric alarms */
    // Alarm on calls to RFQ providers
    for (const dimension of [SoftQuoteMetricDimension, HardQuoteMetricDimension]) {
      const rfqOverallNonQuoteMetric = new aws_cloudwatch.MathExpression({
        expression: '100*(nonQuote/invocations)',
        period: Duration.minutes(5),
        usingMetrics: {
          invocations: new aws_cloudwatch.Metric({
            namespace: 'Uniswap',
            metricName: `${Metric.RFQ_REQUESTED}`,
            dimensionsMap: dimension,
            unit: aws_cloudwatch.Unit.COUNT,
            statistic: 'sum',
          }),
          nonQuote: new aws_cloudwatch.Metric({
            namespace: 'Uniswap',
            metricName: `${Metric.RFQ_NON_QUOTE}`,
            dimensionsMap: dimension,
            unit: aws_cloudwatch.Unit.COUNT,
            statistic: 'sum',
          }),
        },
      });

      const rfqOverallNonQuoteRateAlarmSev3 = new aws_cloudwatch.Alarm(
        this,
        `${dimension.Service}-SEV3-RFQ-NonQuoteRate`,
        {
          alarmName: `${UniswapXParamServiceMetricDimension.Service}-SEV3-RFQ-NonQuoteRate-${dimension.Service}`,
          metric: rfqOverallNonQuoteMetric,
          threshold: 90,
          comparisonOperator: aws_cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          evaluationPeriods: 3,
        }
      );

      const quoteLatencyAlarmSev3 = new aws_cloudwatch.Alarm(this, `${dimension.Service}-SEV3-QuoteLatency`, {
        alarmName: `${UniswapXParamServiceMetricDimension.Service}-SEV3-QuoteLatency-${dimension.Service}`,
        metric: new aws_cloudwatch.Metric({
          namespace: 'Uniswap',
          metricName: `${Metric.QUOTE_LATENCY}`,
          dimensionsMap: dimension,
          unit: aws_cloudwatch.Unit.MILLISECONDS,
          statistic: 'p90',
        }),
        threshold: 2_000,
        comparisonOperator: aws_cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 3,
      });

      if (dimension.Service == HardQuoteMetricDimension.Service) {
        const quotePostErrorMetric = new aws_cloudwatch.MathExpression({
          expression: '100*(postError/invocations)',
          period: Duration.minutes(5),
          usingMetrics: {
            invocations: new aws_cloudwatch.Metric({
              namespace: 'Uniswap',
              metricName: `${Metric.QUOTE_POST_ATTEMPT}`,
              dimensionsMap: dimension,
              unit: aws_cloudwatch.Unit.COUNT,
              statistic: 'sum',
            }),
            postError: new aws_cloudwatch.Metric({
              namespace: 'Uniswap',
              metricName: `${Metric.QUOTE_POST_ERROR}`,
              dimensionsMap: dimension,
              unit: aws_cloudwatch.Unit.COUNT,
              statistic: 'sum',
            }),
          },
        });

        const quotePostErrorAlarmSev3 = new aws_cloudwatch.Alarm(this, `${dimension.Service}-SEV3-PostErrorRate`, {
          alarmName: `${UniswapXParamServiceMetricDimension.Service}-SEV3-PostErrorRate-${dimension.Service}`,
          metric: quotePostErrorMetric,
          evaluationPeriods: 3,
          threshold: 70,
          comparisonOperator: aws_cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        });

        const quotePostErrorAlarmSev2 = new aws_cloudwatch.Alarm(this, `${dimension.Service}-SEV2-PostErrorRate`, {
          alarmName: `${UniswapXParamServiceMetricDimension.Service}-SEV2-PostErrorRate-${dimension.Service}`,
          metric: quotePostErrorMetric,
          evaluationPeriods: 3,
          threshold: 50,
          comparisonOperator: aws_cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        });

        if (chatBotTopic) {
          quotePostErrorAlarmSev3.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
          quotePostErrorAlarmSev2.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
        }
      }

      if (chatBotTopic) {
        rfqOverallNonQuoteRateAlarmSev3.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
        quoteLatencyAlarmSev3.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      }
    }

    // TODO: consider alarming on individual RFQ providers

    if (chatBotTopic) {
      apiAlarm5xxSev2.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      apiAlarm5xxSev3.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      apiAlarm4xxSev3.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      apiAlarmLatencySev2.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      apiAlarmLatencySev3.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      apiAlarmLatencyP99Sev2.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      apiAlarmLatencyP99Sev3.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
    }

    this.url = new CfnOutput(this, 'Url', {
      value: api.url,
    });
  }
}
