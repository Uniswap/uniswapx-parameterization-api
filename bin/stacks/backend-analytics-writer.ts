import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { AccountPrincipal, Effect, IRole, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import * as aws_firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as aws_logs from 'aws-cdk-lib/aws-logs';
import * as aws_s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

import { BACKEND_COSIGNER_ROLE_NAME_PATTERN, SERVICE_NAME } from '../constants';

export type QuoteAnalyticsStreamKey = 'rfqRequest' | 'rfqResponse' | 'hardRequest' | 'hardResponse';

/**
 * The direct-write streams' names, fixed per stage. The quote Lambdas (API stack) are given these
 * names and a grant on them directly: referencing the streams' generated names instead would make
 * the Lambdas depend on this nested stack, which already depends on the Lambdas for its log
 * subscriptions.
 *
 * Fixed names cost one thing: CloudFormation creates a replacement before deleting the original,
 * and Firehose refuses a second stream with the same name, so a change that forces replacement
 * (destination bucket, encryption) must also rename the stream (change the suffix here).
 */
export function quoteAnalyticsDirectStreamNames(stage: string): Record<QuoteAnalyticsStreamKey, string> {
  const name = (suffix: string) => {
    const n = `${SERVICE_NAME}-${stage}-${suffix}`;
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(n)) {
      throw new Error(`Invalid Firehose delivery stream name: ${n}`);
    }
    return n;
  };
  return {
    rfqRequest: name('RfqRequestDirect'),
    rfqResponse: name('RfqResponseDirect'),
    hardRequest: name('HardRequestDirect'),
    hardResponse: name('HardResponseDirect'),
  };
}

export const BACKEND_ANALYTICS_WRITER_ACTIONS = ['firehose:PutRecord', 'firehose:PutRecordBatch'];

// Must match the existing log-driven streams' S3 delivery (see AnalyticsStack) so the files these
// streams write land in the same hourly folders data-eng's BigQuery loader already lists.
const DIRECT_WRITE_S3_BUFFERING = { sizeInMBs: 5, intervalInSeconds: 300 };

// Firehose writes S3 delivery failures (permissions, a missing bucket) here, one log stream per
// delivery stream. Without it a failing stream only shows up as a falling DeliveryToS3.Success.
const DELIVERY_ERROR_LOG_STREAM = 'DestinationDelivery';

export interface BackendAnalyticsWriterProps {
  // Buckets of the existing quote analytics streams, keyed by the record type they hold.
  buckets: Record<QuoteAnalyticsStreamKey, aws_s3.IBucket>;
  // Fixed stream names (quoteAnalyticsDirectStreamNames), so other stacks can reference them.
  streamNames: Record<QuoteAnalyticsStreamKey, string>;
  // The Firehose delivery role that already writes to those buckets.
  firehoseRole: IRole;
  // The webhook-response stream (FirehoseStack), which already takes direct PutRecord writes.
  webhookResponseStreamArn: string;
  // Backend accounts whose `BACKEND_COSIGNER_ROLE_NAME_PATTERN` task role may assume the writer role.
  allowedAccounts: readonly string[];
}

/**
 * Direct-write path into this account's existing S3 → BigQuery analytics buckets, without changing
 * any bucket, table, or query downstream. The quote Lambdas write to it, and the backend `uniswapx`
 * service will after the port.
 *
 * - Four direct-write streams, one per quote record type, delivering into the SAME buckets as the
 *   log-driven streams. They have no transform Lambda: callers put records already in load shape,
 *   one JSON object per record, newline-terminated.
 * - One role the backend task role assumes to put records into those four streams and into the
 *   existing webhook-response stream. Firehose has no resource policies, so cross-account writes
 *   need an assumed role.
 */
export class BackendAnalyticsWriter extends Construct {
  public readonly role: Role;
  public readonly streams: Record<QuoteAnalyticsStreamKey, aws_firehose.CfnDeliveryStream>;
  public readonly deliveryErrorLogGroup: aws_logs.LogGroup;

  constructor(scope: Construct, id: string, props: BackendAnalyticsWriterProps) {
    super(scope, id);
    const [firstAccount, ...otherAccounts] = props.allowedAccounts;
    for (const account of props.allowedAccounts) {
      if (!/^\d{12}$/.test(account)) {
        throw new Error(`Invalid backend analytics writer account id: ${account}`);
      }
    }
    if (!firstAccount) {
      throw new Error('BackendAnalyticsWriter needs at least one allowed account');
    }

    // Error logs only: nothing downstream reads them, so they expire and go with the stack.
    this.deliveryErrorLogGroup = new aws_logs.LogGroup(this, 'DeliveryErrors', {
      retention: aws_logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.deliveryErrorLogGroup.grantWrite(props.firehoseRole);

    const directStream = (streamId: string, key: QuoteAnalyticsStreamKey) => {
      const logStream = new aws_logs.LogStream(this, `${streamId}DeliveryErrors`, {
        logGroup: this.deliveryErrorLogGroup,
        logStreamName: `${props.streamNames[key]}-${DELIVERY_ERROR_LOG_STREAM}`,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      return new aws_firehose.CfnDeliveryStream(this, streamId, {
        deliveryStreamName: props.streamNames[key],
        extendedS3DestinationConfiguration: {
          bucketArn: props.buckets[key].bucketArn,
          roleArn: props.firehoseRole.roleArn,
          compressionFormat: 'UNCOMPRESSED',
          bufferingHints: DIRECT_WRITE_S3_BUFFERING,
          cloudWatchLoggingOptions: {
            enabled: true,
            logGroupName: this.deliveryErrorLogGroup.logGroupName,
            logStreamName: logStream.logStreamName,
          },
        },
      });
    };

    this.streams = {
      rfqRequest: directStream('RfqRequestDirectStream', 'rfqRequest'),
      rfqResponse: directStream('RfqResponseDirectStream', 'rfqResponse'),
      hardRequest: directStream('HardRequestDirectStream', 'hardRequest'),
      hardResponse: directStream('HardResponseDirectStream', 'hardResponse'),
    };

    // One trust statement per account so each condition names only the account its principal
    // trusts; the account-root principal keeps the policy valid before the task role exists.
    const trustedTaskRole = (account: string) =>
      new AccountPrincipal(account).withConditions({
        ArnLike: { 'aws:PrincipalArn': `arn:aws:iam::${account}:role/${BACKEND_COSIGNER_ROLE_NAME_PATTERN}` },
      });
    this.role = new Role(this, 'Role', {
      assumedBy: trustedTaskRole(firstAccount),
      description: 'Assumed by the backend uniswapx service to write GPA analytics records to Firehose',
    });
    for (const account of otherAccounts) {
      this.role.assumeRolePolicy?.addStatements(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['sts:AssumeRole'],
          principals: [trustedTaskRole(account)],
        })
      );
    }

    this.role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: BACKEND_ANALYTICS_WRITER_ACTIONS,
        resources: [...Object.values(this.streams).map((s) => s.attrArn), props.webhookResponseStreamArn],
      })
    );

    new CfnOutput(this, 'RoleArn', { value: this.role.roleArn });
    new CfnOutput(this, 'RfqRequestStreamArn', { value: this.streams.rfqRequest.attrArn });
    new CfnOutput(this, 'RfqResponseStreamArn', { value: this.streams.rfqResponse.attrArn });
    new CfnOutput(this, 'HardRequestStreamArn', { value: this.streams.hardRequest.attrArn });
    new CfnOutput(this, 'HardResponseStreamArn', { value: this.streams.hardResponse.attrArn });
    new CfnOutput(this, 'WebhookResponseStreamArn', { value: props.webhookResponseStreamArn });
  }
}
