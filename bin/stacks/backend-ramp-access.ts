import { ArnFormat, CfnOutput, Stack } from 'aws-cdk-lib';
import { AccountPrincipal, Effect, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

import { BETA_S3_KEY, DYNAMO_TABLE_NAME, PRODUCTION_S3_KEY, WEBHOOK_CONFIG_BUCKET } from '../../lib/constants';
import { STAGE } from '../../lib/util/stage';
import { BACKEND_COSIGNER_ROLE_NAME_PATTERN } from '../constants';

export interface BackendRampAccessProps {
  stage: string;
  // Backend accounts whose `BACKEND_COSIGNER_ROLE_NAME_PATTERN` task role may assume the role.
  allowedAccounts: readonly string[];
}

/**
 * Shared state for the percentage ramp, when trading sends a share of quotes to the backend
 * `uniswapx` service and the rest to these Lambdas. There is one circuit breaker, this stack's
 * fade-rate cron, and it only scores what is in this account's tables. So the backend service
 * must read the same bench state and record the same rows the quote Lambdas do:
 *
 * - FillerCBTimestampsV2: read the bench state on every soft and hard quote (BatchGetItem).
 * - PostedOrders: record each confirmed RFQ-won post (PutItem), so the cron scores it.
 * - FillerAddress: attribute the winning filler address (UpdateItem), so the cron maps the
 *   order's filler back to an endpoint.
 * - The market-maker roster (rfq-config bucket): the same object the quote Lambdas read.
 *
 * Only the request-path operations: the cron's writes (bench state, outcomes) stay here. The roster
 * bucket has no bucket policy and enforces bucket-owner object ownership, so a role in this account
 * reads it without changing the bucket. Tables are referenced by their fixed names, which keeps
 * this construct free of references into the nested cron stack.
 */
export class BackendRampAccess extends Construct {
  public readonly role: Role;

  constructor(scope: Construct, id: string, props: BackendRampAccessProps) {
    super(scope, id);
    const [firstAccount, ...otherAccounts] = props.allowedAccounts;
    for (const account of props.allowedAccounts) {
      if (!/^\d{12}$/.test(account)) {
        throw new Error(`Invalid backend ramp access account id: ${account}`);
      }
    }
    if (!firstAccount) {
      throw new Error('BackendRampAccess needs at least one allowed account');
    }

    // Same trust shape as the analytics writer and the cosigner key: one statement per account,
    // account-root principal (valid before the task role exists) narrowed to the task role.
    const trustedTaskRole = (account: string) =>
      new AccountPrincipal(account).withConditions({
        ArnLike: { 'aws:PrincipalArn': `arn:aws:iam::${account}:role/${BACKEND_COSIGNER_ROLE_NAME_PATTERN}` },
      });
    this.role = new Role(this, 'Role', {
      assumedBy: trustedTaskRole(firstAccount),
      description:
        'Assumed by the backend uniswapx service during the ramp to share circuit-breaker state and the market-maker roster',
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

    const tableArn = (tableName: string) =>
      Stack.of(this).formatArn({
        service: 'dynamodb',
        resource: 'table',
        resourceName: tableName,
        arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      });
    this.role.addToPolicy(
      new PolicyStatement({
        sid: 'ReadBenchState',
        effect: Effect.ALLOW,
        actions: ['dynamodb:BatchGetItem'],
        resources: [tableArn(DYNAMO_TABLE_NAME.FILLER_CB_TIMESTAMPS_V2)],
      })
    );
    this.role.addToPolicy(
      new PolicyStatement({
        sid: 'RecordPostedOrders',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [tableArn(DYNAMO_TABLE_NAME.POSTED_ORDERS)],
      })
    );
    this.role.addToPolicy(
      new PolicyStatement({
        sid: 'RecordFillerAddresses',
        effect: Effect.ALLOW,
        actions: ['dynamodb:UpdateItem'],
        resources: [tableArn(DYNAMO_TABLE_NAME.FILLER_ADDRESS)],
      })
    );

    // Same bucket and key the quote Lambdas read (lib/handlers/shared/quote-injector.ts).
    const rosterKey = props.stage === STAGE.BETA ? BETA_S3_KEY : PRODUCTION_S3_KEY;
    this.role.addToPolicy(
      new PolicyStatement({
        sid: 'ReadMarketMakerRoster',
        effect: Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [`arn:aws:s3:::${WEBHOOK_CONFIG_BUCKET}-${props.stage}-1/${rosterKey}`],
      })
    );

    new CfnOutput(this, 'RoleArn', { value: this.role.roleArn });
  }
}
