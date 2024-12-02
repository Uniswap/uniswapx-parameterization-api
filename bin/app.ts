import * as cdk from 'aws-cdk-lib';
import { CfnOutput, Stack, StackProps, Stage, StageProps } from 'aws-cdk-lib';
import * as chatbot from 'aws-cdk-lib/aws-chatbot';
import { BuildEnvironmentVariableType, BuildSpec } from 'aws-cdk-lib/aws-codebuild';
import { PipelineNotificationEvents } from 'aws-cdk-lib/aws-codepipeline';
import * as sm from 'aws-cdk-lib/aws-secretsmanager';
import { CodeBuildStep, CodePipeline, CodePipelineSource } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import dotenv from 'dotenv';

import { STAGE } from '../lib/util/stage';
import { SERVICE_NAME } from './constants';
import { APIStack } from './stacks/api-stack';
import { ChainId, supportedChains } from '../lib/util/chains';

dotenv.config();

export class APIStage extends Stage {
  public readonly url: CfnOutput;

  constructor(
    scope: Construct,
    id: string,
    props: StageProps & {
      provisionedConcurrency: number;
      internalApiKey?: string;
      chatbotSNSArn?: string;
      stage: string;
      envVars: Record<string, string>;
    }
  ) {
    super(scope, id, props);
    const { provisionedConcurrency, internalApiKey, chatbotSNSArn, stage, env, envVars } = props;

    const { url } = new APIStack(this, `${SERVICE_NAME}API`, {
      env,
      provisionedConcurrency,
      internalApiKey,
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

    const code = CodePipelineSource.connection('Uniswap/uniswapx-parameterization-api', 'main', {
      connectionArn:
        'arn:aws:codestar-connections:us-east-2:644039819003:connection/4806faf1-c31e-4ea2-a5bf-c6fc1fa79487',
    });

    const synthStep = new CodeBuildStep('Synth', {
      input: code,
      buildEnvironment: {
        buildImage: cdk.aws_codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: cdk.aws_codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          NPM_TOKEN: {
            value: 'npm-private-repo-access-token',
            type: BuildEnvironmentVariableType.SECRETS_MANAGER,
          },
          GH_TOKEN: {
            value: 'github-token-2',
            type: BuildEnvironmentVariableType.SECRETS_MANAGER,
          },
          VERSION: {
            value: '1',
            type: BuildEnvironmentVariableType.PLAINTEXT,
          },
          NODE_OPTIONS: {
            value: '--max-old-space-size=8192',
            type: BuildEnvironmentVariableType.PLAINTEXT,
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
              nodejs: '18',
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

    const urlSecrets = sm.Secret.fromSecretAttributes(this, 'urlSecrets', {
      secretCompleteArn: 'arn:aws:secretsmanager:us-east-2:644039819003:secret:gouda-service-api-xCINOs',
    });

    const rfqWebhookConfig = sm.Secret.fromSecretAttributes(this, 'RfqConfig', {
      secretCompleteArn: 'arn:aws:secretsmanager:us-east-2:644039819003:secret:rfq-webhook-config-sy04bH',
    });

    const internalApiKey = sm.Secret.fromSecretAttributes(this, 'internal-api-key', {
      secretCompleteArn:
        'arn:aws:secretsmanager:us-east-2:644039819003:secret:gouda-parameterization-api-internal-api-key-uw4sIa',
    });

    const rpcUrls = sm.Secret.fromSecretAttributes(this, 'rpcUrls', {
      secretCompleteArn:
        'arn:aws:secretsmanager:us-east-2:644039819003:secret:prod/param-api/rpc-urls-HJyniu',
    });

    const jsonRpcProviders = {} as {[chainKey: string]: string};
    supportedChains.forEach(
      (chainId: ChainId) => {
        const mapKey = `RPC_${chainId}`;
        jsonRpcProviders[mapKey] = rpcUrls
          .secretValueFromJson(mapKey)
          .toString();
      }
    );

    // Beta us-east-2
    const betaUsEast2Stage = new APIStage(this, 'beta-us-east-2', {
      env: { account: '801328487475', region: 'us-east-2' },
      provisionedConcurrency: 2,
      internalApiKey: internalApiKey.secretValue.toString(),
      stage: STAGE.BETA,
      envVars: {
        ...jsonRpcProviders,
        RFQ_WEBHOOK_CONFIG: rfqWebhookConfig.secretValue.toString(),
        ORDER_SERVICE_URL: urlSecrets.secretValueFromJson('GOUDA_SERVICE_BETA').toString(),
        FILL_LOG_SENDER_ACCOUNT: '321377678687',
        ORDER_LOG_SENDER_ACCOUNT: '321377678687',
        URA_ACCOUNT: '665191769009',
        BOT_ACCOUNT: '800035746608',
      },
    });

    const betaUsEast2AppStage = pipeline.addStage(betaUsEast2Stage);

    this.addIntegTests(code, betaUsEast2Stage, betaUsEast2AppStage, STAGE.BETA);

    // Prod us-east-2
    const prodUsEast2Stage = new APIStage(this, 'prod-us-east-2', {
      env: { account: '830217277613', region: 'us-east-2' },
      provisionedConcurrency: 70,
      internalApiKey: internalApiKey.secretValue.toString(),
      chatbotSNSArn: 'arn:aws:sns:us-east-2:644039819003:SlackChatbotTopic',
      envVars: {
        ...jsonRpcProviders,
        RFQ_WEBHOOK_CONFIG: rfqWebhookConfig.secretValue.toString(),
        ORDER_SERVICE_URL: urlSecrets.secretValueFromJson('GOUDA_SERVICE_PROD').toString(),
        FILL_LOG_SENDER_ACCOUNT: '316116520258',
        ORDER_LOG_SENDER_ACCOUNT: '316116520258',
        URA_ACCOUNT: '652077092967',
        BOT_ACCOUNT: '456809954954',
      },
      stage: STAGE.PROD,
    });

    const prodUsEast2AppStage = pipeline.addStage(prodUsEast2Stage);

    this.addIntegTests(code, prodUsEast2Stage, prodUsEast2AppStage, STAGE.PROD);

    pipeline.buildPipeline();

    const slackChannel = chatbot.SlackChannelConfiguration.fromSlackChannelConfigurationArn(
      this,
      'SlackChannel',
      'arn:aws:chatbot::644039819003:chat-configuration/slack-channel/eng-ops-protocols-slack-chatbot'
    );

    pipeline.pipeline.notifyOn('NotifySlack', slackChannel, {
      events: [PipelineNotificationEvents.PIPELINE_EXECUTION_FAILED],
    });
  }

  private addIntegTests(
    sourceArtifact: cdk.pipelines.CodePipelineSource,
    apiStage: APIStage,
    applicationStage: cdk.pipelines.StageDeployment,
    stage: STAGE
  ) {
    const cosignerSecret = `param-api/${stage}/cosignerAddress`;
    const testAction = new CodeBuildStep(`${SERVICE_NAME}-IntegTests-${apiStage.stageName}`, {
      projectName: `${SERVICE_NAME}-IntegTests-${apiStage.stageName}`,
      input: sourceArtifact,
      envFromCfnOutputs: {
        UNISWAP_API: apiStage.url,
      },
      buildEnvironment: {
        buildImage: cdk.aws_codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: cdk.aws_codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          NPM_TOKEN: {
            value: 'npm-private-repo-access-token',
            type: BuildEnvironmentVariableType.SECRETS_MANAGER,
          },
          GH_TOKEN: {
            value: 'github-token-2',
            type: BuildEnvironmentVariableType.SECRETS_MANAGER,
          },
          VERSION: {
            value: '1',
            type: BuildEnvironmentVariableType.PLAINTEXT,
          },
          NODE_OPTIONS: {
            value: '--max-old-space-size=8192',
            type: BuildEnvironmentVariableType.PLAINTEXT,
          },
          INTEG_TEST_PK: {
            value: 'param-api/integ-test-pk',
            type: BuildEnvironmentVariableType.SECRETS_MANAGER,
          },
          COSIGNER_ADDR: {
            value: cosignerSecret,
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
              nodejs: '18',
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

envVars['FILL_LOG_SENDER_ACCOUNT'] = process.env['FILL_LOG_SENDER_ACCOUNT'] || '';
envVars['URA_ACCOUNT'] = process.env['URA_ACCOUNT'] || '';
envVars['BOT_ACCOUNT'] = process.env['BOT_ACCOUNT'] || '';
envVars['UNISWAP_API'] = process.env['UNISWAP_API'] || '';
envVars['ORDER_SERVICE_URL'] = process.env['ORDER_SERVICE_URL'] || '';
const jsonRpcProviders = {} as {[chainKey: string]: string};
supportedChains.forEach(
  (chainId: ChainId) => {
    const mapKey = `RPC_${chainId}`;
    jsonRpcProviders[mapKey] = process.env[mapKey] || '';
  }
);

new APIStack(app, `${SERVICE_NAME}Stack`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  provisionedConcurrency: process.env.PROVISION_CONCURRENCY ? parseInt(process.env.PROVISION_CONCURRENCY) : 0,
  internalApiKey: 'test-api-key',
  throttlingOverride: process.env.THROTTLE_PER_FIVE_MINS,
  chatbotSNSArn: process.env.CHATBOT_SNS_ARN,
  stage: STAGE.LOCAL,
  envVars: {
    ...envVars,
    ...jsonRpcProviders,
  },
});

new APIPipeline(app, `${SERVICE_NAME}PipelineStack`, {
  env: { account: '644039819003', region: 'us-east-2' },
});
