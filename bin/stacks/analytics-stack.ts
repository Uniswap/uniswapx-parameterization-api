import * as aws_rs from '@aws-cdk/aws-redshift-alpha';
import * as cdk from 'aws-cdk-lib';
import { CfnOutput } from 'aws-cdk-lib';
import * as aws_ec2 from 'aws-cdk-lib/aws-ec2';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import * as aws_firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as aws_kms from 'aws-cdk-lib/aws-kms';
import * as aws_lambda from 'aws-cdk-lib/aws-lambda';
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as aws_logs from 'aws-cdk-lib/aws-logs';
import * as aws_s3 from 'aws-cdk-lib/aws-s3';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import path from 'path';

const RS_DATABASE_NAME = 'rfq';

const FIREHOSE_IP_ADDRESS_USE2 = '13.58.135.96/27';

enum RS_DATA_TYPES {
  UUID = 'char(36)',
  ADDRESS = 'char(42)',
  UINT256 = 'varchar(78)',
  TIMESTAMP = 'timestamp',
  BIGINT = 'bigint',
  TERMINAL_STATUS = 'varchar(9)', // 'filled' || 'expired' || 'cancelled'
}

export interface AnalyticsStackProps extends cdk.NestedStackProps {
  quoteLambda: aws_lambda_nodejs.NodejsFunction;
}

/**
 * AnalyticsStack
 *  Sets up the Analytics infrastructure for the parameterization service. The final destination is a Redshift cluster that we can run SQL queries against.
 *    This includes:
 *      - CloudWatch Subscription Filters for sending relevant logs events about quote requests and responses to Kinesis Firehose
 *      - 'Data Processors': lambda functions to transform the shape of the log events before they are published to Firehose
 *      - Kinesis Firehose Delivery Stream, which batches log events together and load them to intermediary S3 buckets
 *      - Provisioned Redshift Cluster; transformed log events are COPY'd from S3 to Redshift as the final datawarehouse and analytics engine
 */
export class AnalyticsStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);
    const { quoteLambda } = props;

    /* S3 Initialization */
    const requestBucket = new aws_s3.Bucket(this, 'RequestBucket');
    const fillBucket = new aws_s3.Bucket(this, 'FillBucket');

    /* Redshift Initialization */
    const rsRole = new aws_iam.Role(this, 'RedshiftRole', {
      assumedBy: new aws_iam.ServicePrincipal('redshift.amazonaws.com'),
      managedPolicies: [
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonRedshiftAllCommandsFullAccess'),
        aws_iam.ManagedPolicy.fromAwsManagedPolicyName('SecretsManagerReadWrite'),
      ],
    });

    const key = new aws_kms.Key(this, 'RedshiftCredsKey', {
      enableKeyRotation: false,
    });

    const creds = new sm.Secret(this, 'RsCreds', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        includeSpace: false,
        excludeCharacters: '`"@/\\',
      },
      encryptionKey: key,
    });

    const defaultVpc = aws_ec2.Vpc.fromLookup(this, 'defaultVpc', {
      isDefault: true,
    });

    const subscriptionSG = new aws_ec2.SecurityGroup(this, 'SubscriptionSG', {
      vpc: defaultVpc,
      allowAllOutbound: true,
    });

    // single node of DC2.large provides 0.16TB SSD storage space,
    // which should be sufficient for prototype
    const rsCluster = new aws_rs.Cluster(this, 'ParametrizationCluster', {
      masterUser: {
        masterUsername: 'admin',
        masterPassword: creds.secretValueFromJson('password'),
      },
      vpc: defaultVpc,
      clusterType: aws_rs.ClusterType.SINGLE_NODE,
      nodeType: aws_rs.NodeType.DC2_LARGE,
      defaultDatabaseName: RS_DATABASE_NAME,
      encrypted: false,
      roles: [rsRole],
      vpcSubnets: {
        subnetType: aws_ec2.SubnetType.PUBLIC,
      },
      securityGroups: [subscriptionSG],
      publiclyAccessible: true,
    });

    // docs.aws.amazon.com/firehose/latest/dev/controlling-access.html#using-iam-rs-vpc
    subscriptionSG.addIngressRule(
      aws_ec2.Peer.ipv4(FIREHOSE_IP_ADDRESS_USE2),
      aws_ec2.Port.tcp(rsCluster.clusterEndpoint.port)
    );

    const requestTable = new aws_rs.Table(this, 'requestTable', {
      cluster: rsCluster,
      adminUser: creds,
      databaseName: RS_DATABASE_NAME,
      tableName: 'QuoteRequests',
      tableColumns: [
        { name: 'requestId', dataType: RS_DATA_TYPES.UUID, distKey: true },
        { name: 'offerer', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenIn', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenOut', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'amountIn', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'createdAt', dataType: RS_DATA_TYPES.TIMESTAMP },
      ],
    });

    new aws_rs.Table(this, 'responseTable', {
      cluster: rsCluster,
      adminUser: creds,
      databaseName: RS_DATABASE_NAME,
      tableName: 'QuoteResponses',
      tableColumns: [
        { name: 'quoteId', dataType: RS_DATA_TYPES.UUID },
        { name: 'requestId', dataType: RS_DATA_TYPES.UUID, distKey: true },
        { name: 'offerer', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenIn', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenOut', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'amountIn', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'amountOut', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'filler', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'createdAt', dataType: RS_DATA_TYPES.TIMESTAMP },
      ],
    });

    const archivedOrdersTable = new aws_rs.Table(this, 'archivedOrdersTable', {
      cluster: rsCluster,
      adminUser: creds,
      databaseName: RS_DATABASE_NAME,
      tableName: 'ArchivedOrders',
      tableColumns: [
        { name: 'quoteId', dataType: RS_DATA_TYPES.UUID, distKey: true },
        { name: 'status', dataType: RS_DATA_TYPES.TERMINAL_STATUS },
        { name: 'offerer', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'filler', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'nonce', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'blockNumber', dataType: RS_DATA_TYPES.BIGINT },
        { name: 'tokenOut', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'amountOut', dataType: RS_DATA_TYPES.UINT256 },
      ],
    });

    /* Kinesis Firehose Initialization */
    // TODO: add x-account trust policy
    // https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CreateFirehoseStreamDestination.html
    const firehoseRole = new aws_iam.Role(this, 'FirehoseRole', {
      assumedBy: new aws_iam.ServicePrincipal('firehose.amazonaws.com'),
      managedPolicies: [aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    requestBucket.grantReadWrite(firehoseRole);
    fillBucket.grantReadWrite(firehoseRole);

    const quoteRequestProcessorLambda = new aws_lambda_nodejs.NodejsFunction(this, 'QuoteRequestProcessor', {
      runtime: aws_lambda.Runtime.NODEJS_16_X,
      entry: path.join(__dirname, '../../lib/handlers/index.ts'),
      handler: 'quoteRequestProcessor',
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

    const fillEventProcessorLambda = new aws_lambda_nodejs.NodejsFunction(this, 'FillLogProcessor', {
      runtime: aws_lambda.Runtime.NODEJS_16_X,
      entry: path.join(__dirname, '../../lib/handlers/index.ts'),
      handler: 'fillEventProcessor',
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

    firehoseRole.addToPolicy(
      new aws_iam.PolicyStatement({
        effect: aws_iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction', 'lambda:GetFunctionConfiguration'],
        resources: [quoteRequestProcessorLambda.functionArn, fillEventProcessorLambda.functionArn],
      })
    );
    // CDK doesn't have this implemented yet, so have to use the CloudFormation resource (lower level of abstraction)
    // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-kinesisfirehose-deliverystream.html
    const requestFirehoseStream = new aws_firehose.CfnDeliveryStream(this, 'RequestRedshiftStream', {
      redshiftDestinationConfiguration: {
        clusterJdbcurl: `jdbc:redshift://${rsCluster.clusterEndpoint.hostname}:${rsCluster.clusterEndpoint.port}/${RS_DATABASE_NAME}`,
        username: 'admin',
        password: creds.secretValueFromJson('password').toString(),
        s3Configuration: {
          bucketArn: requestBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          compressionFormat: 'UNCOMPRESSED',
        },
        roleArn: firehoseRole.roleArn,
        copyCommand: {
          copyOptions: "JSON 'auto ignorecase'",
          dataTableName: requestTable.tableName,
          dataTableColumns: 'requestId,offerer,tokenIn,tokenOut,amountIn,createdAt',
        },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'Lambda',
              parameters: [
                {
                  parameterName: 'LambdaArn',
                  parameterValue: quoteRequestProcessorLambda.functionArn,
                },
              ],
            },
          ],
        },
      },
    });

    new aws_firehose.CfnDeliveryStream(this, 'FillRedshiftStream', {
      redshiftDestinationConfiguration: {
        clusterJdbcurl: `jdbc:redshift://${rsCluster.clusterEndpoint.hostname}:${rsCluster.clusterEndpoint.port}/${RS_DATABASE_NAME}`,
        username: 'admin',
        password: creds.secretValueFromJson('password').toString(),
        s3Configuration: {
          bucketArn: fillBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          compressionFormat: 'UNCOMPRESSED',
        },
        roleArn: firehoseRole.roleArn,
        copyCommand: {
          copyOptions: "JSON 'auto ignorecase'",
          dataTableName: archivedOrdersTable.tableName,
          dataTableColumns: 'quoteId,offerer,filler,nonce,blockNumber,tokenOut,amountOut',
        },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'Lambda',
              parameters: [
                {
                  parameterName: 'LambdaArn',
                  parameterValue: fillEventProcessorLambda.functionArn,
                },
              ],
            },
          ],
        },
      },
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
    const cfnSubscriptionFilter = new aws_logs.CfnSubscriptionFilter(this, 'RequestSub', {
      destinationArn: requestFirehoseStream.attrArn,
      filterPattern: '{ $.eventType = "QuoteRequest" }',
      logGroupName: quoteLambda.logGroup.logGroupName,
      roleArn: subscriptionRole.roleArn,
    });

    new CfnOutput(this, 'filterName', {
      value: cfnSubscriptionFilter.toString(),
    });
  }
}
