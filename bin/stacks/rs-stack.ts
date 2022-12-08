import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rss from 'aws-cdk-lib/aws-redshiftserverless';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

// import { VpcStack } from './vpc-stack';

export interface RsStackProps extends cdk.NestedStackProps {
  vpc?: ec2.IVpc;
}

export class RedshiftStack extends cdk.NestedStack {
  public readonly rsRole: iam.IRole;
  public readonly namespace: rss.CfnNamespace;
  public readonly workgroup: rss.CfnWorkgroup;

  constructor(scope: Construct, name: string, props: RsStackProps) {
    super(scope, name, props);

    this.rsRole = new iam.Role(this, 'RedshiftRole', {
      assumedBy: new iam.ServicePrincipal('redshift.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonRedshiftAllCommandsFullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('SecretsManagerReadWrite'),
      ],
    });

    const key = new kms.Key(this, 'RedshiftCredsKey', {
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

    this.namespace = new rss.CfnNamespace(this, 'RedshiftNamespace', {
      namespaceName: 'gouda', // no upper case allowed
      adminUsername: creds.secretValueFromJson('username').toString(),
      adminUserPassword: creds.secretValueFromJson('password').toString(),
      dbName: 'RFQs',
      defaultIamRoleArn: this.rsRole.roleArn,
      iamRoles: [this.rsRole.roleArn],
    });

    // defines the compute resources
    this.workgroup = new rss.CfnWorkgroup(this, 'RedshiftWorkgroup', {
      workgroupName: 'gouda-group',
      namespaceName: this.namespace.namespaceName,
      publiclyAccessible: false,
      configParameters: [
        {
          parameterKey: 'enable_user_activity_logging',
          parameterValue: 'true',
        },
      ],
    });

    this.workgroup.node.addDependency(this.namespace);
  }
}
