import * as aws_firehose from '@aws-cdk/aws-kinesisfirehose-alpha';
import * as firehose_destinations from '@aws-cdk/aws-kinesisfirehose-destinations-alpha';
import * as cdk from 'aws-cdk-lib';
import { CfnOutput } from 'aws-cdk-lib';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as aws_logs from 'aws-cdk-lib/aws-logs';
import * as aws_s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface AnalyticsStackProps extends cdk.NestedStackProps {
  quoteLambda: aws_lambda_nodejs.NodejsFunction;
}

export class AnalyticsStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);
    const { quoteLambda } = props;

    /* S3 Initialization */

    const bucket = new aws_s3.Bucket(this, 'RequestBucket');
    /* Kinesis Firehose Initialization */

    const firehoseStream = new aws_firehose.DeliveryStream(this, 'RequestStream', {
      destinations: [new firehose_destinations.S3Bucket(bucket)],
    });

    const sbuscriptionRole = new aws_iam.Role(this, 'SubscriptionRole', {
      assumedBy: new aws_iam.ServicePrincipal('logs.amazonaws.com'),
    });

    sbuscriptionRole.addToPolicy(
      new aws_iam.PolicyStatement({
        effect: aws_iam.Effect.ALLOW,
        actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
        resources: [firehoseStream.deliveryStreamArn],
      })
    );

    // no L2 constructs available for Kinesis Firehose type SubscriptionFilter, so using L1
    const cfnSubscriptionFilter = new aws_logs.CfnSubscriptionFilter(this, 'RequestSub', {
      destinationArn: firehoseStream.deliveryStreamArn,
      filterPattern: '{ $.statusCode = 200 }',
      logGroupName: quoteLambda.logGroup.logGroupName,
      roleArn: sbuscriptionRole.roleArn,
    });

    new CfnOutput(this, 'filterName', {
      value: cfnSubscriptionFilter.toString(),
    });
  }
}
