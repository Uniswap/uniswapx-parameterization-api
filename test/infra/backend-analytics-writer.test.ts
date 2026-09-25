import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as aws_iam from 'aws-cdk-lib/aws-iam';
import * as aws_s3 from 'aws-cdk-lib/aws-s3';

import { ANALYTICS_WRITER_BACKEND_ACCOUNTS } from '../../bin/config';
import {
  BACKEND_COSIGNER_ROLE_NAME_PATTERN,
  BACKEND_DEV_ACCOUNT,
  BACKEND_PROD_ACCOUNT,
  BACKEND_STAGING_ACCOUNT,
} from '../../bin/constants';
import { BackendAnalyticsWriter } from '../../bin/stacks/backend-analytics-writer';
import { STAGE } from '../../lib/util/stage';

const BETA_ACCOUNT = '801328487475';
const PROD_ACCOUNT = '830217277613';
const WEBHOOK_STREAM_ARN = 'arn:aws:firehose:us-east-2:801328487475:deliverystream/AnalyticsEventsStream';

type Statement = {
  Effect: string;
  Action: string | string[];
  Principal?: { AWS: unknown };
  Resource?: unknown;
  Condition?: Record<string, Record<string, string>>;
};

function synth(ownAccount: string, allowedAccounts: readonly string[]) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'Analytics', { env: { account: ownAccount, region: 'us-east-2' } });
  const bucket = (id: string) => new aws_s3.Bucket(stack, id);
  const buckets = {
    rfqRequest: bucket('RfqRequestBucket'),
    rfqResponse: bucket('RfqResponseBucket'),
    hardRequest: bucket('HardRequestBucket'),
    hardResponse: bucket('HardResponseBucket'),
  };
  const firehoseRole = new aws_iam.Role(stack, 'FirehoseRole', {
    assumedBy: new aws_iam.ServicePrincipal('firehose.amazonaws.com'),
  });
  new BackendAnalyticsWriter(stack, 'BackendAnalyticsWriter', {
    buckets,
    firehoseRole,
    webhookResponseStreamArn: WEBHOOK_STREAM_ARN,
    allowedAccounts,
  });
  const template = Template.fromStack(stack);
  const bucketLogicalId = (b: aws_s3.Bucket) => stack.getLogicalId(b.node.defaultChild as cdk.CfnElement);
  return { template, bucketIds: Object.fromEntries(Object.entries(buckets).map(([k, b]) => [k, bucketLogicalId(b)])) };
}

function writerRole(template: Template) {
  const roles = Object.values(template.findResources('AWS::IAM::Role')).filter((r) =>
    JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes('sts:AssumeRole')
  );
  const writer = roles.filter((r) => !JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes('firehose.'));
  expect(writer).toHaveLength(1);
  return writer[0];
}

function trustedAccounts(template: Template): string[] {
  const statements = writerRole(template).Properties.AssumeRolePolicyDocument.Statement as Statement[];
  return statements.map((s) => {
    const account = (JSON.stringify(s.Principal?.AWS).match(/:iam::(\d{12}):root/) as RegExpMatchArray)[1];
    expect(s.Effect).toEqual('Allow');
    expect(s.Action).toEqual('sts:AssumeRole');
    expect(s.Condition).toEqual({
      ArnLike: { 'aws:PrincipalArn': `arn:aws:iam::${account}:role/${BACKEND_COSIGNER_ROLE_NAME_PATTERN}` },
    });
    return account;
  });
}

describe('BackendAnalyticsWriter', () => {
  it('maps beta to backend dev + staging and prod to backend prod only', () => {
    expect(ANALYTICS_WRITER_BACKEND_ACCOUNTS[STAGE.BETA]).toEqual([BACKEND_DEV_ACCOUNT, BACKEND_STAGING_ACCOUNT]);
    expect(ANALYTICS_WRITER_BACKEND_ACCOUNTS[STAGE.PROD]).toEqual([BACKEND_PROD_ACCOUNT]);
  });

  it('adds one direct-write stream per quote bucket, with no transform and the same S3 delivery', () => {
    const { template, bucketIds } = synth(BETA_ACCOUNT, ANALYTICS_WRITER_BACKEND_ACCOUNTS[STAGE.BETA]);
    const streams = Object.values(template.findResources('AWS::KinesisFirehose::DeliveryStream'));
    expect(streams).toHaveLength(4);
    const targetBuckets = streams.map((s) => {
      const s3 = s.Properties.ExtendedS3DestinationConfiguration;
      expect(s.Properties.S3DestinationConfiguration).toBeUndefined();
      expect(s3.ProcessingConfiguration).toBeUndefined();
      // No prefix: Firehose's default YYYY/MM/DD/HH/ folders are what data-eng's loader lists.
      expect(s3.Prefix).toBeUndefined();
      expect(s3.CompressionFormat).toEqual('UNCOMPRESSED');
      expect(s3.BufferingHints).toEqual({ SizeInMBs: 5, IntervalInSeconds: 300 });
      return s3.BucketARN['Fn::GetAtt'][0];
    });
    expect(targetBuckets.sort()).toEqual(Object.values(bucketIds).sort());
  });

  it('beta: the writer role trusts exactly backend dev and staging task roles, never prod', () => {
    const { template } = synth(BETA_ACCOUNT, ANALYTICS_WRITER_BACKEND_ACCOUNTS[STAGE.BETA]);
    expect(trustedAccounts(template).sort()).toEqual([BACKEND_DEV_ACCOUNT, BACKEND_STAGING_ACCOUNT]);
    expect(JSON.stringify(writerRole(template))).not.toContain(BACKEND_PROD_ACCOUNT);
  });

  it('prod: the writer role trusts exactly the backend prod task role', () => {
    const { template } = synth(PROD_ACCOUNT, ANALYTICS_WRITER_BACKEND_ACCOUNTS[STAGE.PROD]);
    expect(trustedAccounts(template)).toEqual([BACKEND_PROD_ACCOUNT]);
    const trust = JSON.stringify(writerRole(template));
    expect(trust).not.toContain(BACKEND_DEV_ACCOUNT);
    expect(trust).not.toContain(BACKEND_STAGING_ACCOUNT);
  });

  it('lets the writer role only put records, and only to the four direct streams + the webhook stream', () => {
    const { template } = synth(BETA_ACCOUNT, ANALYTICS_WRITER_BACKEND_ACCOUNTS[STAGE.BETA]);
    const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((p) =>
      JSON.stringify(p.Properties.Roles).includes('BackendAnalyticsWriterRole')
    );
    expect(policies).toHaveLength(1);
    const statements = policies[0].Properties.PolicyDocument.Statement as Statement[];
    expect(statements).toHaveLength(1);
    expect([statements[0].Action].flat().sort()).toEqual(['firehose:PutRecord', 'firehose:PutRecordBatch']);
    const resources = statements[0].Resource as unknown[];
    expect(resources).toHaveLength(5);
    expect(resources).toContain(WEBHOOK_STREAM_ARN);
    const streamIds = Object.keys(template.findResources('AWS::KinesisFirehose::DeliveryStream'));
    for (const id of streamIds) {
      expect(resources).toContainEqual({ 'Fn::GetAtt': [id, 'Arn'] });
    }
  });

  it('rejects a malformed account id and an empty account list', () => {
    expect(() => synth(BETA_ACCOUNT, ['41117039233'])).toThrow(/Invalid backend analytics writer account id/);
    expect(() => synth(BETA_ACCOUNT, [])).toThrow(/at least one allowed account/);
  });
});
