import * as cdk from 'aws-cdk-lib';
import { CfnOutput } from 'aws-cdk-lib';
import * as aws_apigateway from 'aws-cdk-lib/aws-apigateway';
import { MethodLoggingLevel } from 'aws-cdk-lib/aws-apigateway';
import * as aws_asg from 'aws-cdk-lib/aws-applicationautoscaling';
import * as aws_dynamo from 'aws-cdk-lib/aws-dynamodb';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import * as aws_lambda from 'aws-cdk-lib/aws-lambda';
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as aws_logs from 'aws-cdk-lib/aws-logs';
import * as aws_waf from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import * as path from 'path';

import { QUOTES_TABLE_INDEX, QUOTES_TABLE_KEY } from '../../lib/config/dynamodb';
import { SERVICE_NAME } from '../constants';
import { AnalyticsStack } from './analytics-stack';

export class APIStack extends cdk.Stack {
  public readonly url: CfnOutput;

  constructor(
    parent: Construct,
    name: string,
    props: cdk.StackProps & {
      provisionedConcurrency: number;
      throttlingOverride?: string;
      chatbotSNSArn?: string;
      stage: string;
      envVars?: { [key: string]: string };
    }
  ) {
    super(parent, name, props);
    const { provisionedConcurrency } = props;

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
     * DDB Initialization
     */
    const quotesTable = new aws_dynamo.Table(this, `${SERVICE_NAME}OrdersTable`, {
      tableName: 'Quotes',
      partitionKey: {
        name: QUOTES_TABLE_KEY.REQUEST_ID,
        type: aws_dynamo.AttributeType.STRING,
      },
      sortKey: {
        name: QUOTES_TABLE_KEY.TYPE,
        type: aws_dynamo.AttributeType.STRING,
      },
      billingMode: aws_dynamo.BillingMode.PAY_PER_REQUEST,
    });

    quotesTable.addGlobalSecondaryIndex({
      indexName: QUOTES_TABLE_INDEX.OFFERER_TYPE,
      partitionKey: {
        name: `${QUOTES_TABLE_KEY.OFFERER}_${QUOTES_TABLE_KEY.TYPE}`,
        type: aws_dynamo.AttributeType.STRING,
      },
      sortKey: {
        name: QUOTES_TABLE_KEY.CREATED_AT,
        type: aws_dynamo.AttributeType.STRING,
      },
      projectionType: aws_dynamo.ProjectionType.ALL,
    });

    quotesTable.addGlobalSecondaryIndex({
      indexName: QUOTES_TABLE_KEY.FILLER,
      partitionKey: {
        name: QUOTES_TABLE_KEY.FILLER,
        type: aws_dynamo.AttributeType.STRING,
      },
      sortKey: {
        name: QUOTES_TABLE_KEY.CREATED_AT,
        type: aws_dynamo.AttributeType.STRING,
      },
      projectionType: aws_dynamo.ProjectionType.ALL,
    });

    /*
     * Lambda Initialization
     */
    const lambdaRole = new aws_iam.Role(this, `$LambdaRole`, {
      assumedBy: new aws_iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonDynamoDBFullAccess'),
      ],
    });

    const quoteLambda = new aws_lambda_nodejs.NodejsFunction(this, 'Quote', {
      role: lambdaRole,
      runtime: aws_lambda.Runtime.NODEJS_16_X,
      entry: path.join(__dirname, '../../lib/handlers/index.ts'),
      handler: 'quoteHandler',
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
      },
      environment: {
        VERSION: '2',
        NODE_OPTIONS: '--enable-source-maps',
      },
    });

    const quoteLambdaAlias = new aws_lambda.Alias(this, `GetOrdersLiveAlias`, {
      aliasName: 'live',
      version: quoteLambda.currentVersion,
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
     * Analytics Stack Initialization
     */

    new AnalyticsStack(this, 'AnalyticsStack', {
      quoteLambda,
    });

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

    this.url = new CfnOutput(this, 'Url', {
      value: api.url,
    });
  }
}
