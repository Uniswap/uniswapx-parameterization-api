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

const RS_DATABASE_NAME = 'uniswap_x'; // must be lowercase
const ADMIN = 'admin';
const FIREHOSE_IP_ADDRESS_USE2 = '13.58.135.96/27';

enum RS_DATA_TYPES {
  UUID = 'char(36)',
  ADDRESS = 'char(42)',
  TX_HASH = 'char(66)',
  UINT256 = 'varchar(78)',
  TIMESTAMP = 'char(10)', // unix timestamp in seconds
  BIGINT = 'bigint',
  INTEGER = 'integer',
  TERMINAL_STATUS = 'varchar(9)', // 'filled' || 'expired' || 'cancelled || 'new' || 'open'
  TRADE_TYPE = 'varchar(12)', // 'EXACT_INPUT' || 'EXACT_OUTPUT'
  ROUTING = 'text',
  CALL_DATA = 'varchar(5000)',
  SLIPPAGE = 'float4',
  UnitInETH = 'float8',
  BOT_EVENT_TYPE = 'text', // 'fetch' || 'filter' || 'execution' || 'quote'
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
  public readonly clusterId: string;
  public readonly dbName: string;
  public readonly credSecretArn: string;

  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);
    const { quoteLambda } = props;

    /* S3 Initialization */
    const rfqRequestBucket = new aws_s3.Bucket(this, 'RfqRequestBucket');
    const unifiedRoutingRequestBucket = new aws_s3.Bucket(this, 'UnifiedRoutingRequestBucket');
    const rfqResponseBucket = new aws_s3.Bucket(this, 'RfqResponseBucket');
    const unifiedRoutingResponseBucket = new aws_s3.Bucket(this, 'UnifiedRoutingResponseBucket');
    const fillBucket = new aws_s3.Bucket(this, 'FillBucket');
    const ordersBucket = new aws_s3.Bucket(this, 'OrdersBucket');
    const botOrderLoaderBucket = new aws_s3.Bucket(this, 'BotOrderLoaderBucket');
    const botOrderRouterBucket = new aws_s3.Bucket(this, 'BotOrderRouterBucket');
    const botOrderBroadcasterBucket = new aws_s3.Bucket(this, 'BotOrderBroadcasterBucket');

    const dsRole = aws_iam.Role.fromRoleArn(this, 'DsRole', 'arn:aws:iam::867401673276:user/bq-load-sa');
    rfqRequestBucket.grantRead(dsRole);
    rfqResponseBucket.grantRead(dsRole);
    unifiedRoutingRequestBucket.grantRead(dsRole);
    unifiedRoutingResponseBucket.grantRead(dsRole);
    fillBucket.grantRead(dsRole);
    ordersBucket.grantRead(dsRole);
    botOrderLoaderBucket.grantRead(dsRole);
    botOrderRouterBucket.grantRead(dsRole);
    botOrderBroadcasterBucket.grantRead(dsRole);

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
    this.credSecretArn = creds.secretArn;

    const vpc = new aws_ec2.Vpc(this, 'RsVpc', {});

    const subscriptionSG = new aws_ec2.SecurityGroup(this, 'SubscriptionSG', {
      vpc: vpc,
      allowAllOutbound: true,
    });

    // single node of DC2.large provides 0.16TB SSD storage space,
    // which should be sufficient for prototype
    const rsCluster = new aws_rs.Cluster(this, 'ParametrizationCluster', {
      masterUser: {
        masterUsername: ADMIN,
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
    this.dbName = RS_DATABASE_NAME;
    this.clusterId = rsCluster.clusterName;

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
        { name: 'swapper', dataType: RS_DATA_TYPES.ADDRESS },
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
        { name: 'swapper', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenIn', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenOut', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'amountIn', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'amountOut', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'endAmountIn', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'endAmountOut', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'amountInGasAdjusted', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'amountOutGasAdjusted', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'tokenInChainId', dataType: RS_DATA_TYPES.INTEGER },
        { name: 'tokenOutChainId', dataType: RS_DATA_TYPES.INTEGER },
        { name: 'slippage', dataType: RS_DATA_TYPES.SLIPPAGE },
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
        { name: 'orderHash', dataType: RS_DATA_TYPES.TX_HASH },
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
        { name: 'gasPriceWei', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'gasUsed', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'gasCostInETH', dataType: RS_DATA_TYPES.UnitInETH },
      ],
    });

    const postedOrdersTable = new aws_rs.Table(this, 'postedOrdersTable', {
      cluster: rsCluster,
      adminUser: creds,
      databaseName: RS_DATABASE_NAME,
      tableName: 'postedOrders',
      tableColumns: [
        { name: 'quoteId', dataType: RS_DATA_TYPES.UUID, distKey: true },
        { name: 'createdAt', dataType: RS_DATA_TYPES.TIMESTAMP },
        { name: 'orderHash', dataType: RS_DATA_TYPES.TX_HASH },
        { name: 'startTime', dataType: RS_DATA_TYPES.TIMESTAMP },
        { name: 'endTime', dataType: RS_DATA_TYPES.TIMESTAMP },
        { name: 'deadline', dataType: RS_DATA_TYPES.TIMESTAMP },
        { name: 'chainId', dataType: RS_DATA_TYPES.INTEGER },
        { name: 'inputStartAmount', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'inputEndAmount', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'tokenIn', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'outputStartAmount', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'outputEndAmount', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'tokenOut', dataType: RS_DATA_TYPES.ADDRESS },
      ],
    });

    const botOrderLoaderTable = new aws_rs.Table(this, 'botOrderLoaderTable', {
      cluster: rsCluster,
      adminUser: creds,
      databaseName: RS_DATABASE_NAME,
      tableName: 'botLoaderEvents3',
      tableColumns: [
        { name: 'eventId', dataType: RS_DATA_TYPES.UUID, distKey: true },
        { name: 'eventType', dataType: RS_DATA_TYPES.BOT_EVENT_TYPE },
        { name: 'timestamp', dataType: RS_DATA_TYPES.TIMESTAMP },

        // order fields
        { name: 'orderHash', dataType: RS_DATA_TYPES.TX_HASH },
        { name: 'chainId', dataType: RS_DATA_TYPES.INTEGER },
      ],
    });

    const botOrderRouterTable = new aws_rs.Table(this, 'botOrderRouterTable', {
      cluster: rsCluster,
      adminUser: creds,
      databaseName: RS_DATABASE_NAME,
      tableName: 'botOrderRouterEvents3',
      tableColumns: [
        { name: 'eventId', dataType: RS_DATA_TYPES.UUID, distKey: true },
        { name: 'eventType', dataType: RS_DATA_TYPES.BOT_EVENT_TYPE },
        { name: 'timestamp', dataType: RS_DATA_TYPES.TIMESTAMP },

        // order fields
        { name: 'orderHash', dataType: RS_DATA_TYPES.TX_HASH },
        { name: 'offerer', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenIn', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenOut', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'startAmountIn', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'endAmountIn', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'startAmountOut', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'endAmountOut', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'chainId', dataType: RS_DATA_TYPES.INTEGER },

        // route fields
        { name: 'callData', dataType: RS_DATA_TYPES.CALL_DATA },
        { name: 'estimatedGasUsed', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'estimatedGasUsedQuoteToken', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'gasPriceWei', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'quote', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'quoteGasAdjusted', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'blockNumber', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'quoteNative', dataType: RS_DATA_TYPES.UINT256 },
      ],
    });

    const botOrderBroadcasterTable = new aws_rs.Table(this, 'botOrderBroadcasterTable', {
      cluster: rsCluster,
      adminUser: creds,
      databaseName: RS_DATABASE_NAME,
      tableName: 'botOrderBroadcastEvents3',
      tableColumns: [
        { name: 'eventId', dataType: RS_DATA_TYPES.UUID, distKey: true },
        { name: 'eventType', dataType: RS_DATA_TYPES.BOT_EVENT_TYPE },
        { name: 'timestamp', dataType: RS_DATA_TYPES.TIMESTAMP },

        // order fields
        { name: 'orderHash', dataType: RS_DATA_TYPES.TX_HASH },
        { name: 'offerer', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenIn', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'tokenOut', dataType: RS_DATA_TYPES.ADDRESS },
        { name: 'startAmountIn', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'endAmountIn', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'startAmountOut', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'endAmountOut', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'chainId', dataType: RS_DATA_TYPES.INTEGER },

        // broadcast fields
        { name: 'goudaGasAdjustedQuote', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'goudaGasUseEstimate', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'gasPriceWei', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'outputProfit', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'outputProfitThreshold', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'nativeProfit', dataType: RS_DATA_TYPES.UINT256 },
        { name: 'callData', dataType: RS_DATA_TYPES.CALL_DATA },
        { name: 'txHash', dataType: RS_DATA_TYPES.TX_HASH },
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
    ordersBucket.grantReadWrite(firehoseRole);
    botOrderLoaderBucket.grantReadWrite(firehoseRole);
    botOrderRouterBucket.grantReadWrite(firehoseRole);
    botOrderBroadcasterBucket.grantReadWrite(firehoseRole);

    const botOrderEventsProcessorLambda = new aws_lambda_nodejs.NodejsFunction(this, 'BotOrderEventsProcessor', {
      runtime: aws_lambda.Runtime.NODEJS_16_X,
      entry: path.join(__dirname, '../../lib/handlers/index.ts'),
      handler: 'botOrderEventsProcessor',
      timeout: cdk.Duration.seconds(60), // AWS suggests 1 min or higher
      memorySize: 512,
      bundling: {
        minify: true,
        sourceMap: true,
      },
      environment: {
        VERSION: '2',
        NODE_OPTIONS: '--enable-source-maps',
      },
    });

    const quoteProcessorLambda = new aws_lambda_nodejs.NodejsFunction(this, 'QuoteRequestProcessor', {
      runtime: aws_lambda.Runtime.NODEJS_16_X,
      entry: path.join(__dirname, '../../lib/handlers/index.ts'),
      handler: 'quoteProcessor',
      timeout: cdk.Duration.seconds(60), // AWS suggests 1 min or higher
      memorySize: 512,
      bundling: {
        minify: true,
        sourceMap: true,
      },
      environment: {
        VERSION: '2',
        NODE_OPTIONS: '--enable-source-maps',
      },
    });

    const postOrderProcessorLambda = new aws_lambda_nodejs.NodejsFunction(this, 'postedOrderProcessor', {
      runtime: aws_lambda.Runtime.NODEJS_16_X,
      entry: path.join(__dirname, '../../lib/handlers/index.ts'),
      handler: 'postOrderProcessor',
      timeout: cdk.Duration.seconds(60), // AWS suggests 1 min or higher
      memorySize: 512,
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
      timeout: cdk.Duration.seconds(60), // AWS suggests 1 min or higher
      memorySize: 512,
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
        resources: [
          quoteProcessorLambda.functionArn,
          fillEventProcessorLambda.functionArn,
          postOrderProcessorLambda.functionArn,
          botOrderEventsProcessorLambda.functionArn,
        ],
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
          dataTableColumns: uraRequestTable.tableColumns.map((column) => column.name).toString(),
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
          dataTableColumns: rfqRequestTable.tableColumns.map((column) => column.name).toString(),
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
          dataTableColumns: uraResponseTable.tableColumns.map((column) => column.name).toString(),
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
          dataTableColumns: rfqResponseTable.tableColumns.map((column) => column.name).toString(),
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
          dataTableColumns: archivedOrdersTable.tableColumns.map((column) => column.name).toString(),
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

    const orderStream = new aws_firehose.CfnDeliveryStream(this, 'OrderStream', {
      redshiftDestinationConfiguration: {
        clusterJdbcurl: `jdbc:redshift://${rsCluster.clusterEndpoint.hostname}:${rsCluster.clusterEndpoint.port}/${RS_DATABASE_NAME}`,
        username: 'admin',
        password: creds.secretValueFromJson('password').toString(),
        s3Configuration: {
          bucketArn: ordersBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          compressionFormat: 'UNCOMPRESSED',
        },
        roleArn: firehoseRole.roleArn,
        copyCommand: {
          copyOptions: "JSON 'auto ignorecase'",
          dataTableName: postedOrdersTable.tableName,
          dataTableColumns: postedOrdersTable.tableColumns.map((column) => column.name).toString(),
        },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'Lambda',
              parameters: [
                {
                  parameterName: 'LambdaArn',
                  parameterValue: postOrderProcessorLambda.functionArn,
                },
              ],
            },
          ],
        },
      },
    });

    const botOrderLoaderStream = new aws_firehose.CfnDeliveryStream(this, 'botOrderLoaderStream', {
      redshiftDestinationConfiguration: {
        clusterJdbcurl: `jdbc:redshift://${rsCluster.clusterEndpoint.hostname}:${rsCluster.clusterEndpoint.port}/${RS_DATABASE_NAME}`,
        username: 'admin',
        password: creds.secretValueFromJson('password').toString(),
        s3Configuration: {
          bucketArn: botOrderLoaderBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          compressionFormat: 'UNCOMPRESSED',
        },
        roleArn: firehoseRole.roleArn,
        copyCommand: {
          copyOptions: "JSON 'auto ignorecase'",
          dataTableName: botOrderLoaderTable.tableName,
          dataTableColumns: botOrderLoaderTable.tableColumns.map((column) => column.name).toString(),
        },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'Lambda',
              parameters: [
                {
                  parameterName: 'LambdaArn',
                  parameterValue: botOrderEventsProcessorLambda.functionArn,
                },
              ],
            },
          ],
        },
      },
    });

    const botOrderRouterStream = new aws_firehose.CfnDeliveryStream(this, 'botOrderRouterStream', {
      redshiftDestinationConfiguration: {
        clusterJdbcurl: `jdbc:redshift://${rsCluster.clusterEndpoint.hostname}:${rsCluster.clusterEndpoint.port}/${RS_DATABASE_NAME}`,
        username: 'admin',
        password: creds.secretValueFromJson('password').toString(),
        s3Configuration: {
          bucketArn: botOrderRouterBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          compressionFormat: 'UNCOMPRESSED',
        },
        roleArn: firehoseRole.roleArn,
        copyCommand: {
          copyOptions: "JSON 'auto ignorecase'",
          dataTableName: botOrderRouterTable.tableName,
          dataTableColumns: botOrderRouterTable.tableColumns.map((column) => column.name).toString(),
        },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'Lambda',
              parameters: [
                {
                  parameterName: 'LambdaArn',
                  parameterValue: botOrderEventsProcessorLambda.functionArn,
                },
              ],
            },
          ],
        },
      },
    });

    const botOrderBroadcasterStream = new aws_firehose.CfnDeliveryStream(this, 'botOrderBroadcasterStream', {
      redshiftDestinationConfiguration: {
        clusterJdbcurl: `jdbc:redshift://${rsCluster.clusterEndpoint.hostname}:${rsCluster.clusterEndpoint.port}/${RS_DATABASE_NAME}`,
        username: 'admin',
        password: creds.secretValueFromJson('password').toString(),
        s3Configuration: {
          bucketArn: botOrderBroadcasterBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          compressionFormat: 'UNCOMPRESSED',
        },
        roleArn: firehoseRole.roleArn,
        copyCommand: {
          copyOptions: "JSON 'auto ignorecase'",
          dataTableName: botOrderBroadcasterTable.tableName,
          dataTableColumns: botOrderBroadcasterTable.tableColumns.map((column) => column.name).toString(),
        },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'Lambda',
              parameters: [
                {
                  parameterName: 'LambdaArn',
                  parameterValue: botOrderEventsProcessorLambda.functionArn,
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

    // A 'CW Logs destination' which is somehow different from the Firehose stream which is supposed to be the
    // destination of the x-account subscription filter; unfortunately there is little documentation on this from AWS
    // had to use Cfn construct because aws-cdk-lib.aws_logs_destinations module doesn't support Firehose
    // https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CreateDestination.html
    const fillDestination = new aws_logs.CfnDestination(this, 'FillEventDestination', {
      roleArn: subscriptionRole.roleArn,
      targetArn: fillStream.attrArn,
      destinationName: 'fillEventDestination',
    });

    const postedOrderDestination = new aws_logs.CfnDestination(this, 'PostedOrderDestination', {
      roleArn: subscriptionRole.roleArn,
      targetArn: orderStream.attrArn,
      destinationName: 'postedOrderDestination',
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

    const botOrderLoaderDestination = new aws_logs.CfnDestination(this, 'botOrderLoaderDestination', {
      roleArn: subscriptionRole.roleArn,
      targetArn: botOrderLoaderStream.attrArn,
      destinationName: 'botOrderLoaderDestination',
    });

    const botOrderRouterDestination = new aws_logs.CfnDestination(this, 'botOrderRouterDestination', {
      roleArn: subscriptionRole.roleArn,
      targetArn: botOrderRouterStream.attrArn,
      destinationName: 'botOrderRouterDestination',
    });

    const botOrderBroadcasterDestination = new aws_logs.CfnDestination(this, 'botOrderBroadcasterDestination', {
      roleArn: subscriptionRole.roleArn,
      targetArn: botOrderBroadcasterStream.attrArn,
      destinationName: 'botOrderBroadcasterDestination',
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
              AWS: props.envVars['FILL_LOG_SENDER_ACCOUNT'],
            },
            Action: 'logs:PutSubscriptionFilter',
            Resource: '*',
          },
        ],
      });
    }

    if (props.envVars['ORDER_LOG_SENDER_ACCOUNT']) {
      postedOrderDestination.destinationPolicy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: '',
            Effect: 'Allow',
            Principal: {
              AWS: props.envVars['FILL_LOG_SENDER_ACCOUNT'],
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

    if (props.envVars['BOT_ACCOUNT']) {
      botOrderLoaderDestination.destinationPolicy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: '',
            Effect: 'Allow',
            Principal: {
              AWS: props.envVars['BOT_ACCOUNT'],
            },
            Action: 'logs:PutSubscriptionFilter',
            Resource: '*',
          },
        ],
      });
      botOrderRouterDestination.destinationPolicy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: '',
            Effect: 'Allow',
            Principal: {
              AWS: props.envVars['BOT_ACCOUNT'],
            },
            Action: 'logs:PutSubscriptionFilter',
            Resource: '*',
          },
        ],
      });
      botOrderBroadcasterDestination.destinationPolicy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: '',
            Effect: 'Allow',
            Principal: {
              AWS: props.envVars['BOT_ACCOUNT'],
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
    new CfnOutput(this, 'postedOrderDestinationName', {
      value: postedOrderDestination.attrArn,
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
    new CfnOutput(this, 'botOrderLoaderDestinationName', {
      value: botOrderLoaderDestination.attrArn,
    });
    new CfnOutput(this, 'botOrderRouterDestinationName', {
      value: botOrderRouterDestination.attrArn,
    });
    new CfnOutput(this, 'botOrderBroadcasterDestinationName', {
      value: botOrderBroadcasterDestination.attrArn,
    });
    new CfnOutput(this, 'BOT_ACCOUNT', {
      value: props.envVars['BOT_ACCOUNT'],
    });
  }
}
