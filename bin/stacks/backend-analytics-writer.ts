import { CfnOutput } from 'aws-cdk-lib';
import { AccountPrincipal, Effect, IRole, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import * as aws_firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as aws_s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

import { BACKEND_COSIGNER_ROLE_NAME_PATTERN } from '../constants';

export const BACKEND_ANALYTICS_WRITER_ACTIONS = ['firehose:PutRecord', 'firehose:PutRecordBatch'];

// Must match the existing log-driven streams' S3 delivery (see AnalyticsStack) so the files these
// streams write land in the same hourly folders data-eng's BigQuery loader already lists.
const DIRECT_WRITE_S3_BUFFERING = { sizeInMBs: 5, intervalInSeconds: 300 };

export interface BackendAnalyticsWriterProps {
  // Buckets of the existing quote analytics streams, keyed by the record type they hold.
  buckets: {
    rfqRequest: aws_s3.IBucket;
    rfqResponse: aws_s3.IBucket;
    hardRequest: aws_s3.IBucket;
    hardResponse: aws_s3.IBucket;
  };
  // The Firehose delivery role that already writes to those buckets.
  firehoseRole: IRole;
  // The webhook-response stream (FirehoseStack), which already takes direct PutRecord writes.
  webhookResponseStreamArn: string;
  // Backend accounts whose `BACKEND_COSIGNER_ROLE_NAME_PATTERN` task role may assume the writer role.
  allowedAccounts: readonly string[];
}

/**
 * Lets the backend `uniswapx` service write GPA's analytics records into this account's existing
 * S3 → BigQuery path after the port, without changing any bucket, table, or query downstream.
 *
 * - Four direct-write streams, one per quote record type, delivering into the SAME buckets as the
 *   log-driven streams. They have no transform Lambda: callers put records already in load shape,
 *   one JSON object per record, newline-terminated. Idle until the backend service starts writing.
 * - One role the backend task role assumes to put records into those four streams and into the
 *   existing webhook-response stream. Firehose has no resource policies, so cross-account writes
 *   need an assumed role.
 */
export class BackendAnalyticsWriter extends Construct {
  public readonly role: Role;
  public readonly streams: Record<keyof BackendAnalyticsWriterProps['buckets'], aws_firehose.CfnDeliveryStream>;

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

    const directStream = (streamId: string, bucket: aws_s3.IBucket) =>
      new aws_firehose.CfnDeliveryStream(this, streamId, {
        extendedS3DestinationConfiguration: {
          bucketArn: bucket.bucketArn,
          roleArn: props.firehoseRole.roleArn,
          compressionFormat: 'UNCOMPRESSED',
          bufferingHints: DIRECT_WRITE_S3_BUFFERING,
        },
      });

    this.streams = {
      rfqRequest: directStream('RfqRequestDirectStream', props.buckets.rfqRequest),
      rfqResponse: directStream('RfqResponseDirectStream', props.buckets.rfqResponse),
      hardRequest: directStream('HardRequestDirectStream', props.buckets.hardRequest),
      hardResponse: directStream('HardResponseDirectStream', props.buckets.hardResponse),
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
