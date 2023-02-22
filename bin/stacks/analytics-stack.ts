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

import { checkDefined } from '../../lib/preconditions/preconditions';

const RS_DATABASE_NAME = 'uniswap_x'; // must be lowercase

const FIREHOSE_IP_ADDRESS_USE2 = '13.58.135.96/27';

enum RS_DATA_TYPES {
  UUID = 'char(36)',
  ADDRESS = 'char(42)',
  TX_HASH = 'char(66)',
  UINT256 = 'varchar(78)',
  TIMESTAMP = 'char(10)', // unix timestamp in seconds
  BIGINT = 'bigint',
  INTEGER = 'integer',
  TERMINAL_STATUS = 'varchar(9)', // 'filled' || 'expired' || 'cancelled'
  TRADE_TYPE = 'varchar(12)', // 'EXACT_INPUT' || 'EXACT_OUTPUT'
  ROUTING = 'text',
}

export interface AnalyticsStackProps extends cdk.NestedStackProps {
  quoteLambda: aws_lambda_nodejs.NodejsFunction;
  envVars: Record<string, string>;
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
    const rfqRequestBucket = new aws_s3.Bucket(this, 'RfqRequestBucket');
    const unifiedRoutingRequestBucket = new aws_s3.Bucket(this, 'UnifiedRoutingRequestBucket');
    const rfqResponseBucket = new aws_s3.Bucket(this, 'RfqResponseBucket');
    const unifiedRoutingResponseBucket = new aws_s3.Bucket(this, 'UnifiedRoutingResponseBucket');
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

    const vpc = new aws_ec2.Vpc(this, 'RsVpc', {});

    const subscriptionSG = new aws_ec2.SecurityGroup(this, 'SubscriptionSG', {
      vpc: vpc,
      allowAllOutbound: true,
    });

    // single node of DC2.large provides 0.16TB SSD storage space,
    // which should be sufficient for prototype
    const rsCluster = new aws_rs.Cluster(this, 'ParametrizationCluster', {
      masterUser: {
        masterUsername: 'admin',
        masterPassword: creds.secretValueFromJson('password'),
      },
      vpc: vpc,
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

    const uraRequestTable = new aws_rs.Table(this, 'UnifiedRoutingRequestTable', {
      cluster: rsCluster,
      adminUser: creds,
      databaseName: RS_DATABASE_NAME,
      tableName: 'UnifiedRoutingRequests',
      tableColumns: [
        { name: 'requestId', dataType: RS_DATA_TYPES.UUID, distKey: true },
        { name: 'offerer', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenIn', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenOut', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'amount', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'type', dataType: RS_DATA_TYPES.TRADE_TYPE },
        { name: 'tokenInChainId', dataType: RS_DATA_TYPES.INTEGER },
        { name: 'tokenOutChainId', dataType: RS_DATA_TYPES.INTEGER },
        { name: 'configs', dataType: RS_DATA_TYPES.ROUTING }, // array as string, e.g. '[DUTCH_LIMIT,CLASSIC]'
        { name: 'createdAt', dataType: RS_DATA_TYPES.TIMESTAMP },
      ],
    });

    const rfqRequestTable = new aws_rs.Table(this, 'RfqRequestTable', {
      cluster: rsCluster,
      adminUser: creds,
      databaseName: RS_DATABASE_NAME,
      tableName: 'RfqRequests',
      tableColumns: [
        { name: 'requestId', dataType: RS_DATA_TYPES.UUID, distKey: true },
        { name: 'offerer', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenIn', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenOut', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'amount', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'type', dataType: RS_DATA_TYPES.TRADE_TYPE },
        { name: 'tokenInChainId', dataType: RS_DATA_TYPES.INTEGER },
        { name: 'tokenOutChainId', dataType: RS_DATA_TYPES.INTEGER },
        { name: 'createdAt', dataType: RS_DATA_TYPES.TIMESTAMP },
      ],
    });

    const uraResponseTable = new aws_rs.Table(this, 'UnifiedRoutingResponseTable', {
      cluster: rsCluster,
      adminUser: creds,
      databaseName: RS_DATABASE_NAME,
      tableName: 'UnifiedRoutingResponses',
      tableColumns: [
        { name: 'quoteId', dataType: RS_DATA_TYPES.UUID },
        { name: 'requestId', dataType: RS_DATA_TYPES.UUID, distKey: true },
        { name: 'offerer', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenIn', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenOut', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'amountIn', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'amountOut', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'amountInGasAdjusted', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'amountOutGasAdjusted', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'tokenInChainId', dataType: RS_DATA_TYPES.INTEGER },
        { name: 'tokenOutChainId', dataType: RS_DATA_TYPES.INTEGER },
        { name: 'gasPriceWei', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'filler', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'routing', dataType: RS_DATA_TYPES.ROUTING },
        { name: 'createdAt', dataType: RS_DATA_TYPES.TIMESTAMP },
      ],
    });

    const rfqResponseTable = new aws_rs.Table(this, 'RfqResponseTable', {
      cluster: rsCluster,
      adminUser: creds,
      databaseName: RS_DATABASE_NAME,
      tableName: 'RfqResponses',
      tableColumns: [
        { name: 'quoteId', dataType: RS_DATA_TYPES.UUID },
        { name: 'requestId', dataType: RS_DATA_TYPES.UUID, distKey: true },
        { name: 'offerer', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenIn', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenOut', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'amountIn', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'amountOut', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'tokenInChainId', dataType: RS_DATA_TYPES.INTEGER },
        { name: 'tokenOutChainId', dataType: RS_DATA_TYPES.INTEGER },
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
        { name: 'orderStatus', dataType: RS_DATA_TYPES.TERMINAL_STATUS },
        { name: 'offerer', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'filler', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'nonce', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'blockNumber', dataType: RS_DATA_TYPES.BIGINT },
        { name: 'txHash', dataType: RS_DATA_TYPES.TX_HASH },
        { name: 'tokenOut', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'amountOut', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'tokenInChainId', dataType: RS_DATA_TYPES.INTEGER },
        { name: 'tokenOutChainId', dataType: RS_DATA_TYPES.INTEGER },
        { name: 'fillTimestamp', dataType: RS_DATA_TYPES.TIMESTAMP },
      ],
    });

    /* Kinesis Firehose Initialization */
    const firehoseRole = new aws_iam.Role(this, 'FirehoseRole', {
      assumedBy: new aws_iam.ServicePrincipal('firehose.amazonaws.com'),
      managedPolicies: [aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    rfqRequestBucket.grantReadWrite(firehoseRole);
    unifiedRoutingRequestBucket.grantReadWrite(firehoseRole);
    rfqResponseBucket.grantReadWrite(firehoseRole);
    unifiedRoutingResponseBucket.grantReadWrite(firehoseRole);
    fillBucket.grantReadWrite(firehoseRole);

    const quoteProcessorLambda = new aws_lambda_nodejs.NodejsFunction(this, 'QuoteRequestProcessor', {
      runtime: aws_lambda.Runtime.NODEJS_16_X,
      entry: path.join(__dirname, '../../lib/handlers/index.ts'),
      handler: 'quoteProcessor',
      timeout: cdk.Duration.seconds(60), // AWS suggests 1 min or higher
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
        resources: [quoteProcessorLambda.functionArn, fillEventProcessorLambda.functionArn],
      })
    );
    // CDK doesn't have this implemented yet, so have to use the CloudFormation resource (lower level of abstraction)
    // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-kinesisfirehose-deliverystream.html
    const uraRequestStream = new aws_firehose.CfnDeliveryStream(this, 'uraRequestStream', {
      redshiftDestinationConfiguration: {
        clusterJdbcurl: `jdbc:redshift://${rsCluster.clusterEndpoint.hostname}:${rsCluster.clusterEndpoint.port}/${RS_DATABASE_NAME}`,
        username: 'admin',
        password: creds.secretValueFromJson('password').toString(),
        s3Configuration: {
          bucketArn: unifiedRoutingRequestBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          compressionFormat: 'UNCOMPRESSED',
        },
        roleArn: firehoseRole.roleArn,
        copyCommand: {
          copyOptions: "JSON 'auto ignorecase'",
          dataTableName: uraRequestTable.tableName,
          dataTableColumns:
            'requestId,offerer,tokenIn,tokenOut,amount,type,tokenInChainId,tokenOutChainId,configs,createdAt',
        },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'Lambda',
              parameters: [
                {
                  parameterName: 'LambdaArn',
                  parameterValue: quoteProcessorLambda.functionArn,
                },
              ],
            },
          ],
        },
      },
    });

    const rfqRequestFirehoseStream = new aws_firehose.CfnDeliveryStream(this, 'RfqRequestStream', {
      redshiftDestinationConfiguration: {
        clusterJdbcurl: `jdbc:redshift://${rsCluster.clusterEndpoint.hostname}:${rsCluster.clusterEndpoint.port}/${RS_DATABASE_NAME}`,
        username: 'admin',
        password: creds.secretValueFromJson('password').toString(),
        s3Configuration: {
          bucketArn: rfqRequestBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          compressionFormat: 'UNCOMPRESSED',
        },
        roleArn: firehoseRole.roleArn,
        copyCommand: {
          copyOptions: "JSON 'auto ignorecase'",
          dataTableName: rfqRequestTable.tableName,
          dataTableColumns: 'requestId,offerer,tokenIn,tokenOut,amount,type,tokenInChainId,tokenOutChainId,createdAt',
        },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'Lambda',
              parameters: [
                {
                  parameterName: 'LambdaArn',
                  parameterValue: quoteProcessorLambda.functionArn,
                },
              ],
            },
          ],
        },
      },
    });

    const uraResponseStream = new aws_firehose.CfnDeliveryStream(this, 'UnifiedRoutingResponseStream', {
      redshiftDestinationConfiguration: {
        clusterJdbcurl: `jdbc:redshift://${rsCluster.clusterEndpoint.hostname}:${rsCluster.clusterEndpoint.port}/${RS_DATABASE_NAME}`,
        username: 'admin',
        password: creds.secretValueFromJson('password').toString(),
        s3Configuration: {
          bucketArn: unifiedRoutingResponseBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          compressionFormat: 'UNCOMPRESSED',
        },
        roleArn: firehoseRole.roleArn,
        copyCommand: {
          copyOptions: "JSON 'auto ignorecase'",
          dataTableName: uraResponseTable.tableName,
          dataTableColumns:
            'quoteId,requestId,offerer,tokenIn,tokenOut,amountInGasAdjusted,amountOutGasAdjusted,amountIn,amountOut,tokenInChainId,tokenOutChainId,routing,createdAt,gasPriceWei',
        },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'Lambda',
              parameters: [
                {
                  parameterName: 'LambdaArn',
                  parameterValue: quoteProcessorLambda.functionArn,
                },
              ],
            },
          ],
        },
      },
    });

    const rfqResponseFirehoseStream = new aws_firehose.CfnDeliveryStream(this, 'RfqResponseStream', {
      redshiftDestinationConfiguration: {
        clusterJdbcurl: `jdbc:redshift://${rsCluster.clusterEndpoint.hostname}:${rsCluster.clusterEndpoint.port}/${RS_DATABASE_NAME}`,
        username: 'admin',
        password: creds.secretValueFromJson('password').toString(),
        s3Configuration: {
          bucketArn: rfqResponseBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          compressionFormat: 'UNCOMPRESSED',
        },
        roleArn: firehoseRole.roleArn,
        copyCommand: {
          copyOptions: "JSON 'auto ignorecase'",
          dataTableName: rfqResponseTable.tableName,
          dataTableColumns:
            'requestId,quoteId,offerer,tokenIn,tokenOut,amountIn,amountOut,tokenInChainId,tokenOutChainId,filler,createdAt',
        },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'Lambda',
              parameters: [
                {
                  parameterName: 'LambdaArn',
                  parameterValue: quoteProcessorLambda.functionArn,
                },
              ],
            },
          ],
        },
      },
    });

    const fillStream = new aws_firehose.CfnDeliveryStream(this, 'FillRedshiftStream', {
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
          dataTableColumns: 'quoteId,offerer,filler,nonce,blockNumber,tokenOut,amountOut,orderStatus,txHash',
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

    //     subscriptionRole.addToPolicy(
    //       new aws_iam.PolicyStatement({
    //         effect: aws_iam.Effect.ALLOW,
    //         actions: ['iam:PassRole'],
    //         resources: [`arn:aws:logs:${this.region}:${checkDefined(props.envVars['FILL_LOG_SENDER_ACCOUNT'])}:*`],
    //       })
    //     );

    // A 'CW Logs destination' which is somehow different from the Firehose stream which is supposed to be the
    // destination of the x-account subscription filter; unfortunately there is little documentation on this from AWS
    // had to use Cfn construct because aws-cdk-lib.aws_logs_destinations module doesn't support Firehose
    // https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CreateDestination.html
    const fillDestination = new aws_logs.CfnDestination(this, 'FillEventDestination', {
      roleArn: subscriptionRole.roleArn,
      targetArn: fillStream.attrArn,
      destinationName: 'fillEventDestination',
    });

    const uraRequestDestination = new aws_logs.CfnDestination(this, 'uraRequestDestination', {
      roleArn: subscriptionRole.roleArn,
      targetArn: uraRequestStream.attrArn,
      destinationName: 'uraRequestDestination',
    });

    const uraResponseDestination = new aws_logs.CfnDestination(this, 'uraResponseDestination', {
      roleArn: subscriptionRole.roleArn,
      targetArn: uraResponseStream.attrArn,
      destinationName: 'uraResponseDestination',
    });
    // hack to get around with CDK bug where `new aws_iam.PolicyDocument({...}).string()` doesn't really turn it into a string
    // enclosed in if statement to allow deploying stack w/o having to set up x-account logging
    if (props.envVars['FILL_LOG_SENDER_ACCOUNT']) {
      fillDestination.destinationPolicy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: '',
            Effect: 'Allow',
            Principal: {
              AWS: checkDefined(props.envVars['FILL_LOG_SENDER_ACCOUNT']),
            },
            Action: 'logs:PutSubscriptionFilter',
            Resource: '*',
          },
        ],
      });
    }
    if (props.envVars['URA_ACCOUNT']) {
      uraRequestDestination.destinationPolicy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: '',
            Effect: 'Allow',
            Principal: {
              AWS: props.envVars['URA_ACCOUNT'],
            },
            Action: 'logs:PutSubscriptionFilter',
            Resource: '*',
          },
        ],
      });
      uraResponseDestination.destinationPolicy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: '',
            Effect: 'Allow',
            Principal: {
              AWS: props.envVars['URA_ACCOUNT'],
            },
            Action: 'logs:PutSubscriptionFilter',
            Resource: '*',
          },
        ],
      });
    }

    // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-logs-subscriptionfilter.html
    // same here regarding CDK not having a stable implementation of this resource
    new aws_logs.CfnSubscriptionFilter(this, 'RequestSub', {
      destinationArn: rfqRequestFirehoseStream.attrArn,
      filterPattern: '{ $.eventType = "QuoteRequest" }',
      logGroupName: quoteLambda.logGroup.logGroupName,
      roleArn: subscriptionRole.roleArn,
    });

    new aws_logs.CfnSubscriptionFilter(this, 'ResponseSub', {
      destinationArn: rfqResponseFirehoseStream.attrArn,
      filterPattern: '{ $.eventType = "QuoteResponse" }',
      logGroupName: quoteLambda.logGroup.logGroupName,
      roleArn: subscriptionRole.roleArn,
    });

    new CfnOutput(this, 'fillDestinationName', {
      value: fillDestination.attrArn,
    });
    new CfnOutput(this, 'uraRequestDestinationName', {
      value: uraRequestDestination.attrArn,
    });
    new CfnOutput(this, 'uraResponseDestinationName', {
      value: uraResponseDestination.attrArn,
    });
    new CfnOutput(this, 'UraAccount', {
      value: props.envVars['URA_ACCOUNT'],
    });
  }
}
