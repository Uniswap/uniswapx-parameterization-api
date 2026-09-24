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

import { ITopic } from 'aws-cdk-lib/aws-sns';
import { DYNAMO_TABLE_NAME, FADES_COUNT_NEVER_FILLED_TERMINAL_AS_FADE_ENV } from '../../lib/constants';
import { STAGE } from '../../lib/util/stage';
import { PROD_TABLE_CAPACITY } from '../config';
import { SERVICE_NAME } from '../constants';
import { LAMBDA_BUNDLING } from './lambda-bundling';

type CapacityOptions = {
  readCapacity?: number;
  writeCapacity?: number;
};

type TableCapacityOptions = {
  billingMode: aws_dynamo.BillingMode;
} & CapacityOptions;

export type TableCapacityConfig = {
  fillerAddress: TableCapacityOptions;
  timestamps: TableCapacityOptions;
};

export interface CronStackProps extends cdk.NestedStackProps {
  lambdaRole: aws_iam.Role;
  stage: string;
  chatbotSNSArn?: string;
  envVars?: { [key: string]: string };
  // Inputs of the fade cron (lib/cron/order-service-fades-source.ts): the PostedOrders table it
  // resolves outcomes in and reads the 24h window from, and the order service it asks for
  // outcomes. Both optional so the stack synthesizes without them.
  postedOrdersTable?: aws_dynamo.ITable;
  orderServiceUrl?: string;
}

export class CronStack extends cdk.NestedStack {
  public readonly fadeRateV2CronLambda?: aws_lambda_nodejs.NodejsFunction;

  constructor(scope: Construct, name: string, props: CronStackProps) {
    super(scope, name, props);
    const { lambdaRole, stage, envVars, chatbotSNSArn, postedOrdersTable, orderServiceUrl } = props;

    const chatbotTopic = chatbotSNSArn
      ? cdk.aws_sns.Topic.fromTopicArn(this, 'ChatbotTopic', chatbotSNSArn)
      : undefined;

    if (stage == STAGE.PROD || STAGE.LOCAL) {
      this.fadeRateV2CronLambda = new aws_lambda_nodejs.NodejsFunction(this, `FadeRateV2Cron`, {
        role: lambdaRole,
        runtime: aws_lambda.Runtime.NODEJS_20_X,
        entry: path.join(__dirname, '../../lib/cron/fade-rate-v2.ts'),
        handler: 'handler',
        timeout: Duration.seconds(240),
        memorySize: 512,
        bundling: LAMBDA_BUNDLING,
        // The breaker reads PostedOrders + the order service only.
        environment: {
          stage: stage,
          ...envVars,
          ...(orderServiceUrl && { ORDER_SERVICE_URL: orderServiceUrl }),
          // Cancelled / insufficient-funds / error orders are not fades (parity with the retired
          // Redshift breaker); 'true' would score them as fades. Expiries always count.
          [FADES_COUNT_NEVER_FILLED_TERMINAL_AS_FADE_ENV]: 'false',
        },
      });
      // The shared Lambda role already carries AmazonDynamoDBFullAccess; the explicit grant
      // documents the dependency (read the window + pending index, write outcomes) and keeps
      // the shadow working if that policy is ever narrowed.
      postedOrdersTable?.grantReadWriteData(this.fadeRateV2CronLambda);

      // Add Sev3 alarm for FadeRateV2Cron lambda errors
      const fadeRateV2CronErrors = this.fadeRateV2CronLambda.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: cdk.aws_cloudwatch.Stats.SUM,
        label: 'FadeRateV2Cron Errors',
      });

      const fadeRateV2CronSev3 = new cdk.aws_cloudwatch.Alarm(this, 'FadeRateV2Cron-SEV3-Errors', {
        metric: fadeRateV2CronErrors,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cdk.aws_cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING,
        actionsEnabled: true,
      });

      if (chatbotTopic) {
        fadeRateV2CronSev3.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatbotTopic));
      }

      new aws_events.Rule(this, `FadeRateV2CronSchedule`, {
        schedule: aws_events.Schedule.rate(Duration.minutes(10)),
        targets: [new aws_events_targets.LambdaFunction(this.fadeRateV2CronLambda)],
      });
    }

    // Circuit-breaker state table. State is derived (recomputed each cron run from PostedOrders
    // and the order service).
    const fillerCBTimestampsV2Table = new aws_dynamo.Table(this, `${SERVICE_NAME}FillerCBTimestampsV2Table`, {
      tableName: DYNAMO_TABLE_NAME.FILLER_CB_TIMESTAMPS_V2,
      partitionKey: {
        name: 'hash',
        type: aws_dynamo.AttributeType.STRING,
      },
      deletionProtection: true,
      pointInTimeRecovery: true,
      contributorInsightsEnabled: true,
      ...PROD_TABLE_CAPACITY.timestamps,
    });
    this.alarmsPerTable(fillerCBTimestampsV2Table, DYNAMO_TABLE_NAME.FILLER_CB_TIMESTAMPS_V2, chatbotTopic);
  }

  private alarmsPerTable(table: aws_dynamo.Table, name: string, chatbotSNSTopic?: ITopic): void {
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

    if (chatbotSNSTopic) {
      userErrorsAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatbotSNSTopic));
      systemErrorsAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatbotSNSTopic));
      writeThrottleAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatbotSNSTopic));
      readThrottleAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatbotSNSTopic));
      writeCapacityAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatbotSNSTopic));
      readCapacityAlarm.addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(chatbotSNSTopic));
    }
  }
}
