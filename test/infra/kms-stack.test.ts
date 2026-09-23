import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { HARD_QUOTE_COSIGNER_BACKEND_ACCOUNTS } from '../../bin/config';
import {
  BACKEND_COSIGNER_ROLE_NAME_PATTERN,
  BACKEND_DEV_ACCOUNT,
  BACKEND_PROD_ACCOUNT,
  BACKEND_STAGING_ACCOUNT,
} from '../../bin/constants';
import { KmsStack } from '../../bin/stacks/kms-stack';
import { STAGE } from '../../lib/util/stage';

const BETA_ACCOUNT = '801328487475';
const PROD_ACCOUNT = '830217277613';
const KEY_NAME = 'GoudaParameterizationHardQuoteCosignerKey-1';

type Statement = {
  Sid?: string;
  Effect: string;
  Principal: { AWS: unknown };
  Action: string | string[];
  Resource: string;
  Condition?: Record<string, Record<string, string>>;
};

function synthKey(ownAccount: string, crossAccountSignerAccounts?: readonly string[]) {
  const app = new cdk.App();
  const parent = new cdk.Stack(app, 'Parent', { env: { account: ownAccount, region: 'us-east-2' } });
  const kms = new KmsStack(parent, KEY_NAME, { crossAccountSignerAccounts });
  const template = Template.fromStack(kms);
  const keys = Object.values(template.findResources('AWS::KMS::Key'));
  expect(keys).toHaveLength(1);
  return { template, key: keys[0], statements: keys[0].Properties.KeyPolicy.Statement as Statement[] };
}

function principalAccount(statement: Statement): string {
  return (JSON.stringify(statement.Principal.AWS).match(/:iam::(\d{12}):root/) as RegExpMatchArray)[1];
}

function crossAccountStatements(statements: Statement[], ownAccount: string): Statement[] {
  return statements.filter((s) => principalAccount(s) !== ownAccount);
}

// Every cross-account statement: only Sign + GetPublicKey, and a condition naming the same account
// as its principal, restricted to the backend service's task role pattern.
function expectScopedSignerStatement(statement: Statement) {
  const account = principalAccount(statement);
  expect(statement.Effect).toEqual('Allow');
  expect([statement.Action].flat().sort()).toEqual(['kms:GetPublicKey', 'kms:Sign']);
  expect(statement.Resource).toEqual('*');
  expect(statement.Condition).toEqual({
    ArnLike: { 'aws:PrincipalArn': `arn:aws:iam::${account}:role/${BACKEND_COSIGNER_ROLE_NAME_PATTERN}` },
  });
  return account;
}

describe('KmsStack hard-quote cosigner key', () => {
  it('maps the beta key to backend dev + staging and the prod key to backend prod only', () => {
    expect(HARD_QUOTE_COSIGNER_BACKEND_ACCOUNTS[STAGE.BETA]).toEqual(['411170392337', '413367642260']);
    expect(HARD_QUOTE_COSIGNER_BACKEND_ACCOUNTS[STAGE.PROD]).toEqual(['654200013602']);
    expect(BACKEND_COSIGNER_ROLE_NAME_PATTERN).toEqual('uniswapx-ecsTaskRole-*');
  });

  it('beta grants exactly backend dev and staging, each scoped by condition, never prod', () => {
    const { statements } = synthKey(BETA_ACCOUNT, HARD_QUOTE_COSIGNER_BACKEND_ACCOUNTS[STAGE.BETA]);
    const cross = crossAccountStatements(statements, BETA_ACCOUNT);
    expect(cross).toHaveLength(2);
    expect(cross.map(expectScopedSignerStatement).sort()).toEqual([BACKEND_DEV_ACCOUNT, BACKEND_STAGING_ACCOUNT]);
    expect(JSON.stringify(statements)).not.toContain(BACKEND_PROD_ACCOUNT);
  });

  it('prod grants exactly backend prod, scoped by condition, never dev or staging', () => {
    const { statements } = synthKey(PROD_ACCOUNT, HARD_QUOTE_COSIGNER_BACKEND_ACCOUNTS[STAGE.PROD]);
    const cross = crossAccountStatements(statements, PROD_ACCOUNT);
    expect(cross).toHaveLength(1);
    expect(cross.map(expectScopedSignerStatement)).toEqual([BACKEND_PROD_ACCOUNT]);
    expect(JSON.stringify(statements)).not.toContain(BACKEND_STAGING_ACCOUNT);
    expect(JSON.stringify(statements)).not.toContain(BACKEND_DEV_ACCOUNT);
  });

  it.each([
    [STAGE.BETA, BETA_ACCOUNT],
    [STAGE.PROD, PROD_ACCOUNT],
  ])('%s: leaves the existing policy statement and every key property unchanged', (stage, ownAccount) => {
    const before = synthKey(ownAccount);
    const after = synthKey(ownAccount, HARD_QUOTE_COSIGNER_BACKEND_ACCOUNTS[stage as STAGE.BETA | STAGE.PROD]);

    // The pre-existing same-account statement survives verbatim; only cross-account ones are added.
    expect(before.statements).toHaveLength(1);
    expect(after.statements.filter((s) => principalAccount(s) === ownAccount)).toEqual(before.statements);

    const withoutPolicy = (props: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(props).filter(([k]) => k !== 'KeyPolicy'));
    expect(withoutPolicy(after.key.Properties)).toEqual(withoutPolicy(before.key.Properties));
    expect(withoutPolicy(after.key.Properties)).toEqual({ KeySpec: 'ECC_SECG_P256K1', KeyUsage: 'SIGN_VERIFY' });
    expect(after.key.DeletionPolicy).toEqual('Retain');
    expect(after.key.UpdateReplacePolicy).toEqual('Retain');
    expect(Object.keys(after.template.findResources('AWS::KMS::Key'))).toEqual(
      Object.keys(before.template.findResources('AWS::KMS::Key'))
    );
    after.template.hasResourceProperties('AWS::KMS::Alias', { AliasName: `alias/${KEY_NAME}` });
  });

  it('adds no statements when no accounts are configured (local stacks)', () => {
    const { statements } = synthKey(BETA_ACCOUNT);
    expect(crossAccountStatements(statements, BETA_ACCOUNT)).toEqual([]);
  });

  it('rejects a malformed account id', () => {
    expect(() => synthKey(BETA_ACCOUNT, ['41117039233'])).toThrow(/Invalid cross-account signer account id/);
  });
});
