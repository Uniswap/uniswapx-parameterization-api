import * as cdk from 'aws-cdk-lib';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import { Construct } from 'constructs';

export interface KinesisStackProps extends cdk.NestedStackProps {
  lambdaRole: aws_iam.Role;
}

export class KinesisStack extends cdk.NestedStack {
  public readonly stream: kinesis.Stream;

  constructor(scope: Construct, name: string, props: KinesisStackProps) {
    super(scope, name, props);

    this.stream = new kinesis.Stream(this, 'GoudaParamStream', {
      streamName: 'GoudaParamStream',
      streamMode: kinesis.StreamMode.ON_DEMAND,
      encryption: kinesis.StreamEncryption.UNENCRYPTED,
    });

    this.stream.grantWrite(props.lambdaRole);
  }
}
