import * as cdk from 'aws-cdk-lib';
import { CfnOutput } from 'aws-cdk-lib';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import * as aws_firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as aws_lambda from 'aws-cdk-lib/aws-lambda';
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as aws_logs from 'aws-cdk-lib/aws-logs';
import * as aws_s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import path from 'path';
import { BackendAnalyticsWriter } from './backend-analytics-writer';
import { LAMBDA_BUNDLING } from './lambda-bundling';

// Pinned to what these streams used as Redshift intermediate-S3 destinations, so object sizes and
// flush cadence don't change for the data-eng BigQuery load that reads these buckets.
const QUOTE_ANALYTICS_S3_BUFFERING = { sizeInMBs: 5, intervalInSeconds: 300 };

export interface AnalyticsStackProps extends cdk.NestedStackProps {
  quoteLambda: aws_lambda_nodejs.NodejsFunction;
  hardQuoteLambda: aws_lambda_nodejs.NodejsFunction;
  envVars: Record<string, string>;
  analyticsStreamArn: string;
  stage: string;
  chatbotSNSArn?: string;
  // Backend accounts that may write analytics records directly (see BackendAnalyticsWriter).
  analyticsWriterBackendAccounts?: readonly string[];
}

/**
 * AnalyticsStack
 *  Sets up the Analytics infrastructure for the parameterization service.
 *    This includes:
 *      - CloudWatch Subscription Filters for sending relevant logs events about quote requests and responses to Kinesis Firehose
 *      - 'Data Processors': lambda functions to transform the shape of the log events before they are published to Firehose
 *      - Kinesis Firehose Delivery Streams, which batch log events together and write them to S3 buckets that data-eng loads into BigQuery
 */
export class AnalyticsStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);
    const { quoteLambda, hardQuoteLambda, analyticsStreamArn, stage, chatbotSNSArn } = props;

    /* S3 Initialization */
    const rfqRequestBucket = new aws_s3.Bucket(this, 'RfqRequestBucket');
    const hardRequestBucket = new aws_s3.Bucket(this, 'HardRequestBucket');
    const unifiedRoutingRequestBucket = new aws_s3.Bucket(this, 'UnifiedRoutingRequestBucket');
    const rfqResponseBucket = new aws_s3.Bucket(this, 'RfqResponseBucket');
    const hardResponseBucket = new aws_s3.Bucket(this, 'HardResponseBucket');
    const unifiedRoutingResponseBucket = new aws_s3.Bucket(this, 'UnifiedRoutingResponseBucket');
    const botOrderLoaderBucket = new aws_s3.Bucket(this, 'BotOrderLoaderBucket');
    const botOrderRouterBucket = new aws_s3.Bucket(this, 'BotOrderRouterBucket');
    const botOrderBroadcasterBucket = new aws_s3.Bucket(this, 'BotOrderBroadcasterBucket');

    const dsRole = aws_iam.Role.fromRoleArn(this, 'DsRole', 'arn:aws:iam::867401673276:user/bq-load-sa');
    rfqRequestBucket.grantRead(dsRole);
    rfqResponseBucket.grantRead(dsRole);
    hardRequestBucket.grantRead(dsRole);
    hardResponseBucket.grantRead(dsRole);
    unifiedRoutingRequestBucket.grantRead(dsRole);
    unifiedRoutingResponseBucket.grantRead(dsRole);
    botOrderLoaderBucket.grantRead(dsRole);
    botOrderRouterBucket.grantRead(dsRole);
    botOrderBroadcasterBucket.grantRead(dsRole);

    /* Kinesis Firehose Initialization */
    const firehoseRole = new aws_iam.Role(this, 'FirehoseRole', {
      assumedBy: new aws_iam.ServicePrincipal('firehose.amazonaws.com'),
      managedPolicies: [aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    rfqRequestBucket.grantReadWrite(firehoseRole);
    hardRequestBucket.grantReadWrite(firehoseRole);
    rfqResponseBucket.grantReadWrite(firehoseRole);
    hardResponseBucket.grantReadWrite(firehoseRole);
    botOrderLoaderBucket.grantReadWrite(firehoseRole);
    botOrderRouterBucket.grantReadWrite(firehoseRole);
    botOrderBroadcasterBucket.grantReadWrite(firehoseRole);

    const quoteProcessorLambda = new aws_lambda_nodejs.NodejsFunction(this, 'QuoteRequestProcessor', {
      runtime: aws_lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../lib/handlers/index.ts'),
      handler: 'quoteProcessor',
      timeout: cdk.Duration.seconds(60), // AWS suggests 1 min or higher
      memorySize: 512,
      bundling: LAMBDA_BUNDLING,
      environment: {
        VERSION: '2',
        NODE_OPTIONS: '--enable-source-maps',
        ANALYTICS_STREAM_ARN: analyticsStreamArn,
        ...props.envVars,
        stage,
      },
    });

    firehoseRole.addToPolicy(
      new aws_iam.PolicyStatement({
        effect: aws_iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction', 'lambda:GetFunctionConfiguration'],
        resources: [quoteProcessorLambda.functionArn],
      })
    );
    let chatBotTopic: cdk.aws_sns.ITopic;
    if (chatbotSNSArn) {
      chatBotTopic = cdk.aws_sns.Topic.fromTopicArn(this, 'ChatbotTopic', chatbotSNSArn);
    }

    /* log processor alarms */
    [quoteProcessorLambda].forEach((lambda) => {
      const successRateSev2Name = `${lambda.node.id}-SEV2-SuccessRate`;
      const successRateSev3Name = `${lambda.node.id}-SEV3-SuccessRate`;

      const errors = lambda.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: cdk.aws_cloudwatch.Stats.SUM,
        label: `${lambda.node.id} Errors`,
      });

      const invocations = lambda.metricInvocations({
        period: cdk.Duration.minutes(5),
        statistic: cdk.aws_cloudwatch.Stats.SUM,
        label: `${lambda.node.id} Invocations`,
      });

      const successRate = new cdk.aws_cloudwatch.MathExpression({
        expression: '100 - 100 * errors / MAX([errors, invocations])',
        usingMetrics: {
          errors,
          invocations,
        },
        label: `${lambda.node.id} Success Rate`,
      });

      const successRateSev2 = new cdk.aws_cloudwatch.Alarm(this, successRateSev2Name, {
        metric: successRate,
        threshold: 60,
        evaluationPeriods: 1,
        comparisonOperator: cdk.aws_cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      });

      const successRateSev3 = new cdk.aws_cloudwatch.Alarm(this, successRateSev3Name, {
        metric: successRate,
        threshold: 90,
        evaluationPeriods: 1,
        comparisonOperator: cdk.aws_cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      });

      if (chatBotTopic) {
        successRateSev2.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
        successRateSev3.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      }
    });

    // CDK doesn't have this implemented yet, so have to use the CloudFormation resource (lower level of abstraction)
    // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-kinesisfirehose-deliverystream.html
    // The quote request/response streams deliver to S3 only. data-eng loads these buckets into BigQuery by
    // listing the default YYYY/MM/DD/HH/ (UTC) key prefix, so keep the bucket, prefix, compression, and
    // buffering unchanged.
    const rfqRequestFirehoseStream = new aws_firehose.CfnDeliveryStream(this, 'RfqRequestStream', {
      extendedS3DestinationConfiguration: {
        bucketArn: rfqRequestBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        compressionFormat: 'UNCOMPRESSED',
        bufferingHints: QUOTE_ANALYTICS_S3_BUFFERING,
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'Lambda',
              parameters: [
                {
                  parameterName: 'LambdaArn',
                  parameterValue: quoteProcessorLambda.functionArn,
                },
              ],
            },
          ],
        },
      },
    });

    const hardRequestFirehoseStream = new aws_firehose.CfnDeliveryStream(this, 'HardRequestStream', {
      extendedS3DestinationConfiguration: {
        bucketArn: hardRequestBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        compressionFormat: 'UNCOMPRESSED',
        bufferingHints: QUOTE_ANALYTICS_S3_BUFFERING,
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'Lambda',
              parameters: [
                {
                  parameterName: 'LambdaArn',
                  parameterValue: quoteProcessorLambda.functionArn,
                },
              ],
            },
          ],
        },
      },
    });

    const hardResponseFirehoseStream = new aws_firehose.CfnDeliveryStream(this, 'HardResponseStream', {
      extendedS3DestinationConfiguration: {
        bucketArn: hardResponseBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        compressionFormat: 'UNCOMPRESSED',
        bufferingHints: QUOTE_ANALYTICS_S3_BUFFERING,
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'Lambda',
              parameters: [
                {
                  parameterName: 'LambdaArn',
                  parameterValue: quoteProcessorLambda.functionArn,
                },
              ],
            },
          ],
        },
      },
    });

    const rfqResponseFirehoseStream = new aws_firehose.CfnDeliveryStream(this, 'RfqResponseStream', {
      extendedS3DestinationConfiguration: {
        bucketArn: rfqResponseBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        compressionFormat: 'UNCOMPRESSED',
        bufferingHints: QUOTE_ANALYTICS_S3_BUFFERING,
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'Lambda',
              parameters: [
                {
                  parameterName: 'LambdaArn',
                  parameterValue: quoteProcessorLambda.functionArn,
                },
              ],
            },
          ],
        },
      },
    });

    /* Firehose Alarms */
    const allStreams = [
      rfqRequestFirehoseStream,
      hardRequestFirehoseStream,
      hardResponseFirehoseStream,
      rfqResponseFirehoseStream,
    ];

    allStreams.forEach((stream) => {
      const s3DeliverySuccessSev3Name = `${stream.node.id}-SEV3-S3Delivery`;
      const s3DeliverySuccessSev2Name = `${stream.node.id}-SEV2-S3Delivery`;
      const missingRecordsName = `UniswapXParameterizationAPI-SEV3-MissingRecords-${stream.node.id}`;

      const deliveryToS3 = new cdk.aws_cloudwatch.Metric({
        namespace: 'AWS/Firehose',
        metricName: 'DeliveryToS3.Success',
        dimensionsMap: {
          DeliveryStreamName: stream.ref,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      });

      const incomingRecords = new cdk.aws_cloudwatch.Metric({
        namespace: 'AWS/Firehose',
        metricName: 'IncomingRecords',
        dimensionsMap: {
          DeliveryStreamName: stream.ref,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });
      const missingRecordsSev3 = new cdk.aws_cloudwatch.Alarm(this, missingRecordsName, {
        metric: incomingRecords,
        comparisonOperator: cdk.aws_cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        threshold: 1,
        evaluationPeriods: (12 * 60) / 5, // 12 hours (12 * 60 / 5 minutes)
        treatMissingData: cdk.aws_cloudwatch.TreatMissingData.BREACHING,
        actionsEnabled: true,
        alarmName: missingRecordsName,
      });
      if (chatBotTopic) {
        missingRecordsSev3.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      }

      const s3DeliverySev3 = new cdk.aws_cloudwatch.Alarm(this, s3DeliverySuccessSev3Name, {
        metric: deliveryToS3,
        threshold: 0.95,
        evaluationPeriods: 3,
        comparisonOperator: cdk.aws_cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        actionsEnabled: true,
      });

      const s3DeliverySev2 = new cdk.aws_cloudwatch.Alarm(this, s3DeliverySuccessSev2Name, {
        metric: deliveryToS3,
        threshold: 0.85,
        evaluationPeriods: 3,
        comparisonOperator: cdk.aws_cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        actionsEnabled: true,
      });

      if (chatBotTopic) {
        [s3DeliverySev3, s3DeliverySev2].forEach((alarm) =>
          alarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic))
        );
      }
    });

    /* Subscription Filter Initialization */
    const subscriptionRole = new aws_iam.Role(this, 'SubscriptionRole', {
      assumedBy: new aws_iam.ServicePrincipal('logs.amazonaws.com'),
    });

    subscriptionRole.addToPolicy(
      new aws_iam.PolicyStatement({
        effect: aws_iam.Effect.ALLOW,
        actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
        resources: ['*'],
      })
    );

    // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-logs-subscriptionfilter.html
    // same here regarding CDK not having a stable implementation of this resource
    new aws_logs.CfnSubscriptionFilter(this, 'RequestSub', {
      destinationArn: rfqRequestFirehoseStream.attrArn,
      filterPattern: '{ $.eventType = "QuoteRequest" }',
      logGroupName: quoteLambda.logGroup.logGroupName,
      roleArn: subscriptionRole.roleArn,
    });

    new aws_logs.CfnSubscriptionFilter(this, 'ResponseSub', {
      destinationArn: rfqResponseFirehoseStream.attrArn,
      filterPattern: '{ $.eventType = "QuoteResponse" }',
      logGroupName: quoteLambda.logGroup.logGroupName,
      roleArn: subscriptionRole.roleArn,
    });

    new aws_logs.CfnSubscriptionFilter(this, 'HardRequestSub', {
      destinationArn: hardRequestFirehoseStream.attrArn,
      filterPattern: '{ $.eventType = "HardRequest" }',
      logGroupName: hardQuoteLambda.logGroup.logGroupName,
      roleArn: subscriptionRole.roleArn,
    });

    new aws_logs.CfnSubscriptionFilter(this, 'HardResponseSub', {
      destinationArn: hardResponseFirehoseStream.attrArn,
      filterPattern: '{ $.eventType = "HardResponse" }',
      logGroupName: hardQuoteLambda.logGroup.logGroupName,
      roleArn: subscriptionRole.roleArn,
    });

    // Direct-write path for the backend uniswapx service: same buckets, no log subscription.
    if (props.analyticsWriterBackendAccounts?.length) {
      new BackendAnalyticsWriter(this, 'BackendAnalyticsWriter', {
        buckets: {
          rfqRequest: rfqRequestBucket,
          rfqResponse: rfqResponseBucket,
          hardRequest: hardRequestBucket,
          hardResponse: hardResponseBucket,
        },
        firehoseRole,
        webhookResponseStreamArn: analyticsStreamArn,
        allowedAccounts: props.analyticsWriterBackendAccounts,
      });
    }

    new CfnOutput(this, 'BOT_ACCOUNT', {
      value: props.envVars['BOT_ACCOUNT'],
    });
  }
}
