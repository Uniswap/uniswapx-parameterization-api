import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { RAMP_ACCESS_BACKEND_ACCOUNTS } from '../../bin/config';
import {
  BACKEND_COSIGNER_ROLE_NAME_PATTERN,
  BACKEND_DEV_ACCOUNT,
  BACKEND_PROD_ACCOUNT,
  BACKEND_STAGING_ACCOUNT,
} from '../../bin/constants';
import { BackendRampAccess } from '../../bin/stacks/backend-ramp-access';
import { STAGE } from '../../lib/util/stage';

const BETA_ACCOUNT = '801328487475';
const PROD_ACCOUNT = '830217277613';

type Statement = {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Principal?: { AWS: unknown };
  Resource?: unknown;
  Condition?: Record<string, Record<string, string>>;
};

function synth(stage: STAGE, ownAccount: string, allowedAccounts: readonly string[]) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'Api', { env: { account: ownAccount, region: 'us-east-2' } });
  new BackendRampAccess(stack, 'BackendRampAccess', { stage, allowedAccounts });
  return Template.fromStack(stack);
}

function roleOf(template: Template) {
  const roles = Object.values(template.findResources('AWS::IAM::Role'));
  expect(roles).toHaveLength(1);
  return roles[0];
}

function trustedAccounts(template: Template): string[] {
  const statements = roleOf(template).Properties.AssumeRolePolicyDocument.Statement as Statement[];
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

function permissions(template: Template): Record<string, { actions: string[]; resource: string }> {
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  expect(policies).toHaveLength(1);
  const statements = policies[0].Properties.PolicyDocument.Statement as Statement[];
  return Object.fromEntries(
    statements.map((s) => {
      expect(s.Effect).toEqual('Allow');
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      // Table ARNs come out of formatArn as Fn::Join over the partition; render them as strings.
      const resource = JSON.stringify(s.Resource);
      return [s.Sid as string, { actions, resource }];
    })
  );
}

describe('BackendRampAccess', () => {
  it('maps beta to backend dev + staging and prod to backend prod only', () => {
    expect(RAMP_ACCESS_BACKEND_ACCOUNTS[STAGE.BETA]).toEqual([BACKEND_DEV_ACCOUNT, BACKEND_STAGING_ACCOUNT]);
    expect(RAMP_ACCESS_BACKEND_ACCOUNTS[STAGE.PROD]).toEqual([BACKEND_PROD_ACCOUNT]);
  });

  it('trusts only the backend task role, one statement per allowed account', () => {
    expect(trustedAccounts(synth(STAGE.BETA, BETA_ACCOUNT, RAMP_ACCESS_BACKEND_ACCOUNTS[STAGE.BETA]))).toEqual([
      BACKEND_DEV_ACCOUNT,
      BACKEND_STAGING_ACCOUNT,
    ]);
    expect(trustedAccounts(synth(STAGE.PROD, PROD_ACCOUNT, RAMP_ACCESS_BACKEND_ACCOUNTS[STAGE.PROD]))).toEqual([
      BACKEND_PROD_ACCOUNT,
    ]);
  });

  it('grants only the request-path operations, each on its own table', () => {
    const p = permissions(synth(STAGE.PROD, PROD_ACCOUNT, [BACKEND_PROD_ACCOUNT]));
    expect(Object.keys(p).sort()).toEqual([
      'ReadBenchState',
      'ReadMarketMakerRoster',
      'RecordFillerAddresses',
      'RecordPostedOrders',
    ]);
    expect(p.ReadBenchState.actions).toEqual(['dynamodb:BatchGetItem']);
    expect(p.ReadBenchState.resource).toContain(`${PROD_ACCOUNT}:table/FillerCBTimestampsV2`);
    expect(p.RecordPostedOrders.actions).toEqual(['dynamodb:PutItem']);
    expect(p.RecordPostedOrders.resource).toContain(`${PROD_ACCOUNT}:table/PostedOrders`);
    expect(p.RecordFillerAddresses.actions).toEqual(['dynamodb:UpdateItem']);
    expect(p.RecordFillerAddresses.resource).toContain(`${PROD_ACCOUNT}:table/FillerAddress`);
  });

  it('reads exactly the roster object the quote Lambdas read for the stage', () => {
    expect(permissions(synth(STAGE.BETA, BETA_ACCOUNT, [BACKEND_DEV_ACCOUNT])).ReadMarketMakerRoster).toEqual({
      actions: ['s3:GetObject'],
      resource: JSON.stringify('arn:aws:s3:::rfq-config-beta-1/beta.json'),
    });
    expect(permissions(synth(STAGE.PROD, PROD_ACCOUNT, [BACKEND_PROD_ACCOUNT])).ReadMarketMakerRoster).toEqual({
      actions: ['s3:GetObject'],
      resource: JSON.stringify('arn:aws:s3:::rfq-config-prod-1/production.json'),
    });
  });

  it('rejects an empty or malformed account list', () => {
    expect(() => synth(STAGE.BETA, BETA_ACCOUNT, [])).toThrow(/at least one/);
    expect(() => synth(STAGE.BETA, BETA_ACCOUNT, ['123'])).toThrow(/Invalid backend ramp access account id/);
  });
});
