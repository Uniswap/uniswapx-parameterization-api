import * as cdk from 'aws-cdk-lib';
import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { AccountPrincipal, Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { KeySpec, KeyUsage } from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

import { BACKEND_COSIGNER_ROLE_NAME_PATTERN } from '../constants';

export const CROSS_ACCOUNT_COSIGNER_ACTIONS = ['kms:Sign', 'kms:GetPublicKey'];

export interface KmsStackProps {
  // Other AWS accounts whose `BACKEND_COSIGNER_ROLE_NAME_PATTERN` roles may sign with the key.
  crossAccountSignerAccounts?: readonly string[];
}

export class KmsStack extends cdk.NestedStack {
  public readonly key: cdk.aws_kms.Key;

  constructor(parent: Construct, name: string, props: KmsStackProps = {}) {
    super(parent, name);

    /**
     * Unless absolutely necessary, DO NOT change this construct.
     * This uses the 'Retain' DeletionPolicy, which will cause the resource to be retained
     * in the account, but orphaned from the stack if the Key construct is ever changed.
     */
    this.key = new cdk.aws_kms.Key(this, name, {
      removalPolicy: RemovalPolicy.RETAIN,
      keySpec: KeySpec.ECC_SECG_P256K1,
      keyUsage: KeyUsage.SIGN_VERIFY,
      alias: name,
    });

    // Key-policy half of cross-account signing; the caller's role also needs its own IAM allow.
    // The principal is the account root so the policy is valid before the role exists, narrowed
    // by name with aws:PrincipalArn. One statement per account so each condition names only the
    // account its principal trusts.
    for (const account of props.crossAccountSignerAccounts ?? []) {
      if (!/^\d{12}$/.test(account)) {
        throw new Error(`Invalid cross-account signer account id: ${account}`);
      }
      this.key.addToResourcePolicy(
        new PolicyStatement({
          sid: `CrossAccountCosigner${account}`,
          effect: Effect.ALLOW,
          principals: [new AccountPrincipal(account)],
          actions: CROSS_ACCOUNT_COSIGNER_ACTIONS,
          resources: ['*'],
          conditions: {
            ArnLike: { 'aws:PrincipalArn': `arn:aws:iam::${account}:role/${BACKEND_COSIGNER_ROLE_NAME_PATTERN}` },
          },
        })
      );
    }

    new CfnOutput(this, `${name}KeyId`, {
      value: this.key.keyId,
    });
  }
}
