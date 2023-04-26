import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { default as Logger } from 'bunyan';

import { checkDefined } from '../../preconditions/preconditions';
import { WebhookConfiguration, WebhookConfigurationProvider } from '.';

// reads endpoint configuration from a static file
export class S3WebhookConfigurationProvider implements WebhookConfigurationProvider {
  private log: Logger;
  private endpoints: WebhookConfiguration[];

  constructor(_log: Logger, private bucket: string, private key: string) {
    this.endpoints = [];
    this.log = _log.child({ quoter: 'S3WebhookConfigurationProvider' });
  }

  async getEndpoints(): Promise<WebhookConfiguration[]> {
    // TODO add time based lookup as well
    if (this.endpoints.length === 0) {
      await this.fetchEndpoints();
    }
    return this.endpoints;
  }

  async fetchEndpoints(): Promise<void> {
    this.log.info(`Fetching endpoints from ${this.bucket} with key ${this.key}`);
    const s3Client = new S3Client({});
    const s3Res = await s3Client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
      })
    );
    this.log.info(`S3 result`, s3Res);
    const s3Body = checkDefined(s3Res.Body, 's3Res.Body is undefined');
    this.endpoints = JSON.parse(await s3Body.transformToString()) as WebhookConfiguration[];

    this.log.info(`Fetched ${this.endpoints.length} endpoints from S3`, this.endpoints);
  }
}
