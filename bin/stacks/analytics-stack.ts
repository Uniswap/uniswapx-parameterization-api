import * as aws_firehose from '@aws-cdk/aws-kinesisfirehose-alpha';
import * as cdk from 'aws-cdk-lib';
import * as aws_kinesis from 'aws-cdk-lib/aws-kinesis';
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as aws_logs from 'aws-cdk-lib/aws-logs';
import * as destinations from 'aws-cdk-lib/aws-logs-destinations';
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

    const kinesisStream = new aws_kinesis.Stream(this, 'GoudaParamStream', {
      streamName: 'GoudaParamStream',
      streamMode: aws_kinesis.StreamMode.ON_DEMAND,
      encryption: aws_kinesis.StreamEncryption.UNENCRYPTED,
    });

    quoteLambda.logGroup.addSubscriptionFilter('RequestSub', {
      destination: new destinations.KinesisDestination(kinesisStream),
      filterPattern: aws_logs.FilterPattern.numberValue('$.statusCode', '=', 200),
    });
  }
}
