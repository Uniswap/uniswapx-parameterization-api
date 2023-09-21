// import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { default as Logger } from 'bunyan';

// import { checkDefined } from '../../preconditions/preconditions';
import { WebhookConfiguration, WebhookConfigurationProvider } from '.';

export type FillerAddressesMap = Map<string, Set<string>>;

// reads endpoint configuration from a static file
export class S3WebhookConfigurationProvider implements WebhookConfigurationProvider {
  private log: Logger;
  private endpoints: WebhookConfiguration[];
  private lastUpdatedEndpointsTimestamp: number;

  // try to refetch endpoints every 5 mins
  private static UPDATE_ENDPOINTS_PERIOD_MS = 5 * 60000;

  constructor(_log: Logger, private bucket: string, private key: string) {
    this.bucket;
    this.key;
    this.endpoints = [];
    this.log = _log.child({ quoter: 'S3WebhookConfigurationProvider' });
    this.lastUpdatedEndpointsTimestamp = Date.now();
  }

  fillers(): string[] {
    return [...new Set(this.endpoints.map((endpoint) => endpoint.name))];
  }

  async addressToFiller(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (this.endpoints.length === 0) {
      await this.fetchEndpoints();
    }
    this.log.info({ endpoints: this.endpoints }, 'fetched endpoints from S3');
    this.endpoints.forEach((endpoint) => {
      endpoint.addresses?.forEach((address) => {
        this.log.info({ address, endpoint }, 'address to filler mapping');
        map.set(address, endpoint.name);
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
    // const s3Client = new S3Client({});
    // const s3Res = await s3Client.send(
    //   new GetObjectCommand({
    //     Bucket: this.bucket,
    //     Key: this.key,
    //   })
    // );
    // const s3Body = checkDefined(s3Res.Body, 's3Res.Body is undefined');
    // this.endpoints = JSON.parse(await s3Body.transformToString()) as WebhookConfiguration[];
    this.endpoints = [
      {
        endpoint: 'https://webhook.site/46525f4b-fc9a-4fac-80d7-a0c862f47d95',
        name: 'Flow Traders',
        addresses: ['0x165d98de005d2818176b99b1a93b9325dbe58181', '0x752e87b5f1397e171d5383cec3d4c51a8d3c114b'],
      },
    ];

    this.log.info(`Fetched ${this.endpoints.length} endpoints from S3`, this.endpoints);
  }
}
