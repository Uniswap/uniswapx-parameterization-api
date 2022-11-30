import * as cdk from 'aws-cdk-lib';
import * as asg from 'aws-cdk-lib/aws-applicationautoscaling';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import * as aws_lambda from 'aws-cdk-lib/aws-lambda';
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

import { STAGE } from '../../lib/util/stage';
import { SERVICE_NAME } from '../constants';

export interface LambdaStackProps extends cdk.NestedStackProps {
  provisionedConcurrency: number;
  stage: STAGE;
  envVars?: { [key: string]: string };
}

export class LambdaStack extends cdk.NestedStack {
  private readonly helloWorldLambda: aws_lambda_nodejs.NodejsFunction;
  public readonly helloWorldLambdaAlias: aws_lambda.Alias;

  constructor(scope: Construct, name: string, props: LambdaStackProps) {
    super(scope, name, props);
    const { provisionedConcurrency } = props;

    const lambdaName = `${SERVICE_NAME}Lambda`;

    const lambdaRole = new aws_iam.Role(this, `${lambdaName}-LambdaRole`, {
      assumedBy: new aws_iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonDynamoDBFullAccess'),
      ],
    });

    this.helloWorldLambda = new aws_lambda_nodejs.NodejsFunction(this, `HelloWorld${lambdaName}`, {
      role: lambdaRole,
      runtime: aws_lambda.Runtime.NODEJS_16_X,
      entry: path.join(__dirname, '../../lib/handlers/index.ts'),
      handler: 'helloWorldHandler',
      memorySize: 128,
      bundling: {
        minify: true,
        sourceMap: true,
      },
      environment: {
        VERSION: '2',
        NODE_OPTIONS: '--enable-source-maps',
      },
    });

    this.helloWorldLambdaAlias = new aws_lambda.Alias(this, `GetOrdersLiveAlias`, {
      aliasName: 'live',
      version: this.helloWorldLambda.currentVersion,
      provisionedConcurrentExecutions: provisionedConcurrency > 0 ? provisionedConcurrency : undefined,
    });

    if (provisionedConcurrency > 0) {
      const helloWorldTarget = new asg.ScalableTarget(this, `${lambdaName}-PostOrder-ProvConcASG`, {
        serviceNamespace: asg.ServiceNamespace.LAMBDA,
        maxCapacity: provisionedConcurrency * 5,
        minCapacity: provisionedConcurrency,
        resourceId: `function:${this.helloWorldLambdaAlias.lambda.functionName}:${this.helloWorldLambdaAlias.aliasName}`,
        scalableDimension: 'lambda:function:ProvisionedConcurrency',
      });

      helloWorldTarget.node.addDependency(this.helloWorldLambdaAlias);
    }
  }
}
