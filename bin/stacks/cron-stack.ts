import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import * as aws_events from 'aws-cdk-lib/aws-events';
import * as aws_events_targets from 'aws-cdk-lib/aws-events-targets';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import * as aws_lambda from 'aws-cdk-lib/aws-lambda';
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

import { SERVICE_NAME } from '../constants';

export interface CronStackProps extends cdk.NestedStackProps {
  RsDatabase: string;
  RsClusterIdentifier: string;
  RedshiftCredSecretArn: string;
  lambdaRole: aws_iam.Role;
}

export class CronStack extends cdk.NestedStack {
  public readonly fadeRateCronLambda: aws_lambda_nodejs.NodejsFunction;

  constructor(scope: Construct, name: string, props: CronStackProps) {
    super(scope, name, props);
    const { RsDatabase, RsClusterIdentifier, RedshiftCredSecretArn, lambdaRole } = props;

    this.fadeRateCronLambda = new aws_lambda_nodejs.NodejsFunction(this, `${SERVICE_NAME}FadeRate`, {
      role: lambdaRole,
      runtime: aws_lambda.Runtime.NODEJS_16_X,
      entry: path.join(__dirname, '../../lib/cron/fade-rate.ts'),
      handler: 'handler',
      timeout: Duration.seconds(240),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
      },
      environment: {
        REDSHIFT_DATABASE: RsDatabase,
        REDSHIFT_CLUSTER_IDENTIFIER: RsClusterIdentifier,
        REDSHIFT_SECRET_ARN: RedshiftCredSecretArn,
      },
    });
    new aws_events.Rule(this, `${SERVICE_NAME}ScheduleCronLambda`, {
      schedule: aws_events.Schedule.rate(Duration.minutes(5)),
      targets: [new aws_events_targets.LambdaFunction(this.fadeRateCronLambda)],
    });
  }
}
