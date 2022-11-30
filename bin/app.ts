import * as cdk from 'aws-cdk-lib';
import { CfnOutput, Stage, StageProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import dotenv from 'dotenv';

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
    }
  ) {
    super(scope, id, props);
    const { provisionedConcurrency, chatbotSNSArn, stage, env } = props;

    const { url } = new APIStack(this, `${SERVICE_NAME}API`, {
      env,
      provisionedConcurrency,
      chatbotSNSArn,
      stage,
    });
    this.url = url;
  }
}

// Local Dev Stack
const app = new cdk.App();
new APIStack(app, `${SERVICE_NAME}Stack`, {
  provisionedConcurrency: process.env.PROVISION_CONCURRENCY ? parseInt(process.env.PROVISION_CONCURRENCY) : 0,
  throttlingOverride: process.env.THROTTLE_PER_FIVE_MINS,
  chatbotSNSArn: process.env.CHATBOT_SNS_ARN,
  stage: STAGE.LOCAL,
});
