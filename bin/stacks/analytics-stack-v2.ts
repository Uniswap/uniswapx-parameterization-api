import * as cdk from 'aws-cdk-lib';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import * as aws_firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as aws_s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * AnalyticsStackV2
 *  Sets up a single Firehose stream that can be reused by all handlers to
 *  log analytics events to the same S3 bucket dynamically partitioned by eventType.
 */

export class AnalyticsStackV2 extends cdk.NestedStack {
  public readonly streamArn: string;

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
      extendedS3DestinationConfiguration: {
        bucketArn: analyticsEventsBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        compressionFormat: 'GZIP',
        dynamicPartitioningConfiguration: {
          enabled: true,
        },
        prefix: 'events/!{partitionKeyFromQuery:eventType}/!{timestamp:yyyy/MM/dd/HH}/',
        errorOutputPrefix: "errors/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd/HH}/",
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'MetadataExtraction',
              parameters: [
                {
                  parameterName: 'MetadataExtractionQuery',
                  parameterValue: '{eventType:.eventType}',
                },
                {
                  parameterName: 'JsonParsingEngine',
                  parameterValue: 'JQ-1.6',
                },
              ],
            },
            {
              type: 'AppendDelimiterToRecord',
              parameters: [
                {
                  parameterName: 'Delimiter',
                  parameterValue: '\\n',
                }
              ],
            },
          ],
        },
      } 
    });
    this.streamArn = analyticsEventsStream.attrArn;
  }
}
