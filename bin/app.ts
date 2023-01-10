import * as cdk from 'aws-cdk-lib';
import { CfnOutput, SecretValue, Stack, StackProps, Stage, StageProps } from 'aws-cdk-lib';
import { BuildEnvironmentVariableType, BuildSpec } from 'aws-cdk-lib/aws-codebuild';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import { CodeBuildStep, CodePipeline, CodePipelineSource } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import dotenv from 'dotenv';

import { SUPPORTED_CHAINS } from '../lib/config/chains';
import { ChainId } from '../lib/util/chains';
import { STAGE } from '../lib/util/stage';
import { SERVICE_NAME } from './constants';
import { APIStack } from './stacks/api-stack';

dotenv.config();

export class APIStage extends Stage {
  public readonly url: CfnOutput;

  constructor(
    scope: Construct,
    id: string,
    props: StageProps & {
      provisionedConcurrency: number;
      chatbotSNSArn?: string;
      stage: string;
      envVars: Record<string, string>;
    }
  ) {
    super(scope, id, props);
    const { provisionedConcurrency, chatbotSNSArn, stage, env, envVars } = props;

    const { url } = new APIStack(this, `${SERVICE_NAME}API`, {
      env,
      provisionedConcurrency,
      chatbotSNSArn,
      stage,
      envVars,
    });
    this.url = url;
  }
}

export class APIPipeline extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const code = CodePipelineSource.gitHub('Uniswap/gouda-parameterization-api', 'main', {
      authentication: SecretValue.secretsManager('github-token-2'),
    });

    const synthStep = new CodeBuildStep('Synth', {
      input: code,
      buildEnvironment: {
        buildImage: cdk.aws_codebuild.LinuxBuildImage.STANDARD_6_0,
        environmentVariables: {
          NPM_TOKEN: {
            value: 'npm-private-repo-access-token',
            type: BuildEnvironmentVariableType.SECRETS_MANAGER,
          },
          GH_TOKEN: {
            value: 'github-token-2',
            type: BuildEnvironmentVariableType.SECRETS_MANAGER,
          },
        },
      },
      commands: [
        'git config --global url."https://${GH_TOKEN}@github.com/".insteadOf ssh://git@github.com/',
        'echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc && yarn install --frozen-lockfile --network-concurrency 1',
        'yarn build',
        'npx cdk synth --verbose',
      ],
      partialBuildSpec: BuildSpec.fromObject({
        phases: {
          install: {
            'runtime-versions': {
              nodejs: '16',
            },
          },
        },
      }),
    });

    const pipeline = new CodePipeline(this, `${SERVICE_NAME}Pipeline`, {
      // The pipeline name
      pipelineName: `${SERVICE_NAME}`,
      crossAccountKeys: true,
      synth: synthStep,
    });

    // Secrets are stored in secrets manager in the pipeline account. Accounts we deploy to
    // have been granted permissions to access secrets via resource policies.
    const goudaRpc = sm.Secret.fromSecretAttributes(this, 'goudaRpc', {
      secretCompleteArn: 'arn:aws:secretsmanager:us-east-2:644039819003:secret:gouda-service-rpc-urls-E4FbSb',
    });

    const jsonRpcUrls: { [chain: string]: string } = {};
    SUPPORTED_CHAINS.forEach((chainId: ChainId) => {
      const key = `RPC_${chainId}`;
      jsonRpcUrls[`RPC_${chainId}`] = goudaRpc.secretValueFromJson(key).toString();
    });
    jsonRpcUrls['RPC_TENDERLY'] = goudaRpc.secretValueFromJson('RPC_TENDERLY').toString();

    // Beta us-east-2

    const betaUsEast2Stage = new APIStage(this, 'beta-us-east-2', {
      env: { account: '801328487475', region: 'us-east-2' },
      provisionedConcurrency: 2,
      stage: STAGE.BETA,
      envVars: {
        ...jsonRpcUrls,
        FILL_LOG_SENDER_ACCOUNT: '321377678687',
      },
    });

    const betaUsEast2AppStage = pipeline.addStage(betaUsEast2Stage);

    this.addIntegTests(code, betaUsEast2Stage, betaUsEast2AppStage);

    // Prod us-east-2
    const prodUsEast2Stage = new APIStage(this, 'prod-us-east-2', {
      env: { account: '830217277613', region: 'us-east-2' },
      provisionedConcurrency: 5,
      chatbotSNSArn: 'arn:aws:sns:us-east-2:644039819003:SlackChatbotTopic',
      envVars: {
        ...jsonRpcUrls,
        FILL_LOG_SENDER_ACCOUNT: '316116520258',
      },
      stage: STAGE.PROD,
    });

    const prodUsEast2AppStage = pipeline.addStage(prodUsEast2Stage);

    this.addIntegTests(code, prodUsEast2Stage, prodUsEast2AppStage);

    pipeline.buildPipeline();
  }

  private addIntegTests(
    sourceArtifact: cdk.pipelines.CodePipelineSource,
    apiStage: APIStage,
    applicationStage: cdk.pipelines.StageDeployment
  ) {
    const testAction = new CodeBuildStep(`${SERVICE_NAME}-IntegTests-${apiStage.stageName}`, {
      projectName: `${SERVICE_NAME}-IntegTests-${apiStage.stageName}`,
      input: sourceArtifact,
      envFromCfnOutputs: {
        UNISWAP_API: apiStage.url,
      },
      buildEnvironment: {
        buildImage: cdk.aws_codebuild.LinuxBuildImage.STANDARD_6_0,
        environmentVariables: {
          NPM_TOKEN: {
            value: 'npm-private-repo-access-token',
            type: BuildEnvironmentVariableType.SECRETS_MANAGER,
          },
          GH_TOKEN: {
            value: 'github-token-2',
            type: BuildEnvironmentVariableType.SECRETS_MANAGER,
          },
        },
      },
      commands: [
        'git config --global url."https://${GH_TOKEN}@github.com/".insteadOf ssh://git@github.com/',
        'echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc',
        'echo "UNISWAP_API=${UNISWAP_API}" > .env',
        'yarn install --frozen-lockfile --network-concurrency 1',
        'yarn build',
        'yarn test:integ',
      ],
      partialBuildSpec: BuildSpec.fromObject({
        phases: {
          install: {
            'runtime-versions': {
              nodejs: '16',
            },
          },
        },
      }),
    });

    applicationStage.addPost(testAction);
  }
}

// Local Dev Stack
const app = new cdk.App();

const envVars: { [key: string]: string } = {};

Object.values(SUPPORTED_CHAINS).forEach((chainId) => {
  envVars[`RPC_${chainId}`] = process.env[`RPC_${chainId}`] || '';
});
envVars[`RPC_TENDERLY`] = process.env[`RPC_TENDERLY`] || '';
envVars['FILL_LOG_SENDER_ACCOUNT'] = process.env['FILL_LOG_SENDER_ACCOUNT'] || '';

new APIStack(app, `${SERVICE_NAME}Stack`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  provisionedConcurrency: process.env.PROVISION_CONCURRENCY ? parseInt(process.env.PROVISION_CONCURRENCY) : 0,
  throttlingOverride: process.env.THROTTLE_PER_FIVE_MINS,
  chatbotSNSArn: process.env.CHATBOT_SNS_ARN,
  stage: STAGE.LOCAL,
  envVars,
});

new APIPipeline(app, `${SERVICE_NAME}PipelineStack`, {
  env: { account: '644039819003', region: 'us-east-2' },
});
