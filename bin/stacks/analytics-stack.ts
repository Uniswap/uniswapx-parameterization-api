import * as cdk from 'aws-cdk-lib';
import { CfnOutput } from 'aws-cdk-lib';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import * as aws_s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { BackendAnalyticsWriter, quoteAnalyticsDirectStreamNames } from './backend-analytics-writer';

export interface AnalyticsStackProps extends cdk.NestedStackProps {
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
 *      - The S3 buckets data-eng loads into BigQuery
 *      - The quote analytics Firehose streams that the quote Lambdas write records to directly (BackendAnalyticsWriter)
 *      - Delivery alarms on those streams
 */
export class AnalyticsStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);
    const { analyticsStreamArn, stage, chatbotSNSArn } = props;

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

    let chatBotTopic: cdk.aws_sns.ITopic;
    if (chatbotSNSArn) {
      chatBotTopic = cdk.aws_sns.Topic.fromTopicArn(this, 'ChatbotTopic', chatbotSNSArn);
    }

    // The quote analytics streams: the quote Lambdas write their records straight to them, and the
    // backend uniswapx service will after the port. They exist only where a backend account may
    // write (every deployed stage); the local stack has none and its Lambdas log records instead.
    new CfnOutput(this, 'BOT_ACCOUNT', {
      value: props.envVars['BOT_ACCOUNT'],
    });
    if (!props.analyticsWriterBackendAccounts?.length) {
      return;
    }
    const writer = new BackendAnalyticsWriter(this, 'BackendAnalyticsWriter', {
      buckets: {
        rfqRequest: rfqRequestBucket,
        rfqResponse: rfqResponseBucket,
        hardRequest: hardRequestBucket,
        hardResponse: hardResponseBucket,
      },
      firehoseRole,
      streamNames: quoteAnalyticsDirectStreamNames(stage),
      webhookResponseStreamArn: analyticsStreamArn,
      allowedAccounts: props.analyticsWriterBackendAccounts,
    });

    /* Firehose Alarms */
    Object.values(writer.streams).forEach((stream) => {
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
  }
}
