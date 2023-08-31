import * as cdk from 'aws-cdk-lib';
import { aws_cloudwatch, Duration } from 'aws-cdk-lib';
import * as aws_dynamo from 'aws-cdk-lib/aws-dynamodb';
import { Operation } from 'aws-cdk-lib/aws-dynamodb';
import * as aws_events from 'aws-cdk-lib/aws-events';
import * as aws_events_targets from 'aws-cdk-lib/aws-events-targets';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import * as aws_lambda from 'aws-cdk-lib/aws-lambda';
import * as aws_lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import * as path from 'path';

import { DYNAMO_TABLE_KEY, DYNAMO_TABLE_NAME } from '../../lib/constants';
import { PARTITION_KEY } from '../../lib/repositories/switch-repository';
import { PROD_TABLE_CAPACITY } from '../config';
import { SERVICE_NAME } from '../constants';

type CapacityOptions = {
  readCapacity?: number;
  writeCapacity?: number;
};

type TableCapacityOptions = {
  billingMode: aws_dynamo.BillingMode;
} & CapacityOptions;

export type TableCapacityConfig = {
  fadeRate: TableCapacityOptions;
  synthSwitch: TableCapacityOptions;
};

export interface CronStackProps extends cdk.NestedStackProps {
  RsDatabase: string;
  RsClusterIdentifier: string;
  RedshiftCredSecretArn: string;
  lambdaRole: aws_iam.Role;
  chatbotSNSArn?: string;
}

export class CronStack extends cdk.NestedStack {
  public readonly fadeRateCronLambda: aws_lambda_nodejs.NodejsFunction;
  public readonly synthSwitchCronLambda: aws_lambda_nodejs.NodejsFunction;

  constructor(scope: Construct, name: string, props: CronStackProps) {
    super(scope, name, props);
    const { RsDatabase, RsClusterIdentifier, RedshiftCredSecretArn, lambdaRole, chatbotSNSArn } = props;

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
      schedule: aws_events.Schedule.rate(Duration.minutes(10)),
      targets: [new aws_events_targets.LambdaFunction(this.fadeRateCronLambda)],
    });

    this.synthSwitchCronLambda = new aws_lambda_nodejs.NodejsFunction(this, `${SERVICE_NAME}SynthSwitch`, {
      role: lambdaRole,
      runtime: aws_lambda.Runtime.NODEJS_16_X,
      entry: path.join(__dirname, '../../lib/cron/synth-switch.ts'),
      handler: 'handler',
      timeout: Duration.seconds(240),
      memorySize: 1024,
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
    new aws_events.Rule(this, `${SERVICE_NAME}SynthSwitchSchedule`, {
      // TODO: change schedule
      schedule: aws_events.Schedule.rate(Duration.hours(1)),
      targets: [new aws_events_targets.LambdaFunction(this.synthSwitchCronLambda)],
    });

    /* RFQ fade rate table */
    const fadesTable = new aws_dynamo.Table(this, `${SERVICE_NAME}FadesTable`, {
      tableName: DYNAMO_TABLE_NAME.FADES,
      partitionKey: {
        name: DYNAMO_TABLE_KEY.FILLER,
        type: aws_dynamo.AttributeType.STRING,
      },
      deletionProtection: true,
      pointInTimeRecovery: true,
      contributorInsightsEnabled: true,
      ...PROD_TABLE_CAPACITY.fadeRate,
    });
    this.alarmsPerTable(fadesTable, DYNAMO_TABLE_NAME.FADES, chatbotSNSArn);

    const synthSwitchTable = new aws_dynamo.Table(this, `${SERVICE_NAME}SynthSwitchTable`, {
      tableName: DYNAMO_TABLE_NAME.SYNTHETIC_SWITCH,
      partitionKey: {
        name: PARTITION_KEY,
        type: aws_dynamo.AttributeType.STRING,
      },
      deletionProtection: true,
      pointInTimeRecovery: true,
      contributorInsightsEnabled: true,
      ...PROD_TABLE_CAPACITY.synthSwitch,
    });
    this.alarmsPerTable(synthSwitchTable, DYNAMO_TABLE_NAME.SYNTHETIC_SWITCH, chatbotSNSArn);
  }

  private alarmsPerTable(table: aws_dynamo.Table, name: string, chatbotSNSArn?: string): void {
    const readCapacityAlarm = new aws_cloudwatch.Alarm(this, `${SERVICE_NAME}-SEV3-${name}-ReadCapacityAlarm`, {
      alarmName: `${SERVICE_NAME}-SEV3-${name}-ReadCapacityAlarm`,
      metric: table.metricConsumedReadCapacityUnits(),
      threshold: 80,
      evaluationPeriods: 2,
    });

    const writeCapacityAlarm = new aws_cloudwatch.Alarm(this, `${SERVICE_NAME}-SEV3-${name}-WriteCapacityAlarm`, {
      alarmName: `${SERVICE_NAME}-SEV3-${name}-WriteCapacityAlarm`,
      metric: table.metricConsumedWriteCapacityUnits(),
      threshold: 80,
      evaluationPeriods: 2,
    });

    const readThrottleAlarm = new aws_cloudwatch.Alarm(this, `${SERVICE_NAME}-SEV3-${name}-ReadThrottlesAlarm`, {
      alarmName: `${SERVICE_NAME}-SEV3-${name}-ReadThrottlesAlarm`,
      metric: table.metricThrottledRequestsForOperations({
        operations: [
          Operation.GET_ITEM,
          Operation.BATCH_GET_ITEM,
          Operation.BATCH_WRITE_ITEM,
          Operation.PUT_ITEM,
          Operation.QUERY,
          Operation.SCAN,
          Operation.UPDATE_ITEM,
          Operation.DELETE_ITEM,
        ],
      }),
      threshold: 10,
      evaluationPeriods: 2,
    });

    const writeThrottleAlarm = new aws_cloudwatch.Alarm(this, `${SERVICE_NAME}-SEV3-${name}-WriteThrottlesAlarm`, {
      alarmName: `${SERVICE_NAME}-SEV3-${name}-WriteThrottlesAlarm`,
      metric: table.metricThrottledRequestsForOperations({
        operations: [
          Operation.GET_ITEM,
          Operation.BATCH_GET_ITEM,
          Operation.BATCH_WRITE_ITEM,
          Operation.PUT_ITEM,
          Operation.QUERY,
          Operation.SCAN,
          Operation.UPDATE_ITEM,
          Operation.DELETE_ITEM,
        ],
      }),
      threshold: 10,
      evaluationPeriods: 2,
    });

    const systemErrorsAlarm = new aws_cloudwatch.Alarm(this, `${SERVICE_NAME}-SEV3-${name}-SystemErrorsAlarm`, {
      alarmName: `${SERVICE_NAME}-SEV3-${name}-SystemErrorsAlarm`,
      metric: table.metricSystemErrorsForOperations({
        operations: [
          Operation.GET_ITEM,
          Operation.BATCH_GET_ITEM,
          Operation.BATCH_WRITE_ITEM,
          Operation.PUT_ITEM,
          Operation.QUERY,
          Operation.SCAN,
          Operation.UPDATE_ITEM,
          Operation.DELETE_ITEM,
        ],
      }),
      threshold: 10,
      evaluationPeriods: 2,
    });

    const userErrorsAlarm = new aws_cloudwatch.Alarm(this, `${SERVICE_NAME}-SEV3-${name}-UserErrorsAlarm`, {
      alarmName: `${SERVICE_NAME}-SEV3-${name}-UserErrorsAlarm`,
      metric: table.metricUserErrors(),
      threshold: 10,
      evaluationPeriods: 2,
    });

    if (chatbotSNSArn) {
      const chatBotTopic = cdk.aws_sns.Topic.fromTopicArn(this, 'ChatbotTopic', chatbotSNSArn);
      userErrorsAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      systemErrorsAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      writeThrottleAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      readThrottleAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      writeCapacityAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
      readCapacityAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatBotTopic));
    }
  }
}
