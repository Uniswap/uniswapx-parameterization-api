import * as cdk from 'aws-cdk-lib';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import * as aws_firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as aws_s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * FirehoseStack
 *  Sets up a single Firehose delivery stream that can be reused by all handlers to
 *  log analytics events to the same destination S3 bucket as GZIP compressed newline JSON.
 *  This format is optimized for loading into BigQuery.
 */

export class FirehoseStack extends cdk.NestedStack {
  public readonly analyticsStreamArn: string;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    /* S3 Initialization */
    const analyticsEventsBucket = new aws_s3.Bucket(this, 'AnalyticsEventsBucket');
    const bqLoadRole = aws_iam.Role.fromRoleArn(this, 'BqLoadRole', 'arn:aws:iam::867401673276:user/bq-load-sa');
    analyticsEventsBucket.grantRead(bqLoadRole);

    /* Kinesis Firehose Initialization */
    const firehoseRole = new aws_iam.Role(this, 'FirehoseRole', {
      assumedBy: new aws_iam.ServicePrincipal('firehose.amazonaws.com'),
      managedPolicies: [aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    analyticsEventsBucket.grantReadWrite(firehoseRole);

    // CDK doesn't have this implemented yet, so have to use the CloudFormation resource (lower level of abstraction)
    // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-kinesisfirehose-deliverystream.html

    const analyticsEventsStream = new aws_firehose.CfnDeliveryStream(this, 'AnalyticsEventsStream', {
      s3DestinationConfiguration: {
        bucketArn: analyticsEventsBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        compressionFormat: 'GZIP',
        prefix: 'events/',
      } 
    });
    this.analyticsStreamArn = analyticsEventsStream.attrArn;

    // Role for CloudWatch in Order Service to deliver subscription-filter traffic to this Firehose stream
    const logsToFirehoseRole = new aws_iam.Role(this, 'LogsToFirehoseRole', {
      assumedBy: new aws_iam.ServicePrincipal('logs.us-east-2.amazonaws.com', {
        conditions: {
          StringEquals: {
            'aws:SourceAccount': ['321377678687', '316116520258'], // Order Service Beta, Prod
          },
          ArnLike: {
            'aws:SourceArn': [
              'arn:aws:logs:us-east-2:321377678687:log-group:/aws/lambda/GoudaService*', // Beta
              'arn:aws:logs:us-east-2:316116520258:log-group:/aws/lambda/GoudaService*', // Prod
            ],
          },
        },
      }),
      description: 'Assumed by CloudWatch in Order Service beta/prod to write to Firehose',
    });
    logsToFirehoseRole.addToPolicy(new aws_iam.PolicyStatement({
      actions: ['firehose:PutRecord', 'firehose:PutRecordBatch', 'firehose:DescribeDeliveryStream'],
      resources: [analyticsEventsStream.attrArn],
    }));

    new cdk.CfnOutput(this, 'LogsToFirehoseRoleArn', { value: logsToFirehoseRole.roleArn });
  }
}
