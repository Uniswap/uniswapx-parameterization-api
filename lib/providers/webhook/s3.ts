import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { default as Logger } from 'bunyan';

import { checkDefined } from '../../preconditions/preconditions';
import { WebhookConfiguration, WebhookConfigurationProvider } from './base';

export type FillerAddressesMap = Map<string, Set<string>>;

// reads endpoint configuration from a static file
export class S3WebhookConfigurationProvider extends WebhookConfigurationProvider {
  // try to refetch endpoints every 5 mins
  private static UPDATE_ENDPOINTS_PERIOD_MS = 5 * 60000;
  private static s3Client = new S3Client({});

  constructor(_log: Logger, private bucket: string, private key: string) {
    super(_log);
  }

  async addressToFiller(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (this.endpoints.length === 0) {
      await this.fetchEndpoints();
    }
    this.endpoints.forEach((endpoint) => {
      endpoint.addresses?.forEach((address) => {
        this.log.info({ address, endpoint }, 'address to filler mapping');
        map.set(address, endpoint.hash);
      });
    });
    return map;
  }

  async getEndpoints(): Promise<WebhookConfiguration[]> {
    if (
      this.endpoints.length === 0 ||
      Date.now() - this.lastUpdatedEndpointsTimestamp > S3WebhookConfigurationProvider.UPDATE_ENDPOINTS_PERIOD_MS
    ) {
      await this.fetchEndpoints();
      this.lastUpdatedEndpointsTimestamp = Date.now();
    }
    return this.endpoints;
  }

  async fetchEndpoints(): Promise<void> {
    const s3Res = await S3WebhookConfigurationProvider.s3Client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
      })
    );
    const s3Body = checkDefined(s3Res.Body, 's3Res.Body is undefined');
    this.endpoints = JSON.parse(await s3Body.transformToString()) as WebhookConfiguration[];
    this.log.info({ endpoints: this.endpoints }, `Fetched ${this.endpoints.length} endpoints from S3`);
  }
  
  async updateEndpoints(endpoints: WebhookConfiguration[]): Promise<void> {
    await S3WebhookConfigurationProvider.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
        Body: JSON.stringify(endpoints),
      })
    ); 
    return;
  }
}
