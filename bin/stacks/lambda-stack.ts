import * as cdk from 'aws-cdk-lib';
import * as asg from 'aws-cdk-lib/aws-applicationautoscaling';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import * as aws_lambda from 'aws-cdk-lib/aws-lambda';
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as aws_logs from 'aws-cdk-lib/aws-logs';
import * as destinations from 'aws-cdk-lib/aws-logs-destinations';
import { Construct } from 'constructs';
import * as path from 'path';

import { STAGE } from '../../lib/util/stage';
import { SERVICE_NAME } from '../constants';
import { DynamoStack } from './dynamo-stack';
import { KinesisStack } from './kinesis-stack';

export interface LambdaStackProps extends cdk.NestedStackProps {
  provisionedConcurrency: number;
  stage: STAGE;
  envVars?: { [key: string]: string };
}

export class LambdaStack extends cdk.NestedStack {
  private readonly quoteLambda: aws_lambda_nodejs.NodejsFunction;
  public readonly quoteLambdaAlias: aws_lambda.Alias;

  constructor(scope: Construct, name: string, props: LambdaStackProps) {
    super(scope, name, props);
    const { provisionedConcurrency } = props;

    /*
     * DDB Initialization
     */
    new DynamoStack(this, `${SERVICE_NAME}Dynamo`, {});

    /*
     * Redshift Initialization
     */
    // new RedshiftStack(this, `${SERVICE_NAME}Redshift`, {});

    /* Lambda Initialization */

    const lambdaRole = new aws_iam.Role(this, `$LambdaRole`, {
      assumedBy: new aws_iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonDynamoDBFullAccess'),
      ],
    });

    this.quoteLambda = new aws_lambda_nodejs.NodejsFunction(this, 'Quote', {
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

    this.quoteLambdaAlias = new aws_lambda.Alias(this, `GetOrdersLiveAlias`, {
      aliasName: 'live',
      version: this.quoteLambda.currentVersion,
      provisionedConcurrentExecutions: provisionedConcurrency > 0 ? provisionedConcurrency : undefined,
    });

    if (provisionedConcurrency > 0) {
      const quoteTarget = new asg.ScalableTarget(this, 'QuoteProvConcASG', {
        serviceNamespace: asg.ServiceNamespace.LAMBDA,
        maxCapacity: provisionedConcurrency * 5,
        minCapacity: provisionedConcurrency,
        resourceId: `function:${this.quoteLambdaAlias.lambda.functionName}:${this.quoteLambdaAlias.aliasName}`,
        scalableDimension: 'lambda:function:ProvisionedConcurrency',
      });

      quoteTarget.node.addDependency(this.quoteLambdaAlias);
    }

    /*
     * Kinesis-related Initialization
     */
    const kinesisStack = new KinesisStack(this, `${SERVICE_NAME}Kinesis`, { lambdaRole });

    this.quoteLambda.logGroup.addSubscriptionFilter('RequestSub', {
      destination: new destinations.KinesisDestination(kinesisStack.stream),
      filterPattern: aws_logs.FilterPattern.numberValue('$.statusCode', '=', 200),
    });
  }
}
