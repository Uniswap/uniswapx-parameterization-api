import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { default as Logger } from 'bunyan';

import { ProtocolVersion, WebhookConfiguration, WebhookConfigurationProvider } from '.';
import { checkDefined } from '../../preconditions/preconditions';

export type FillerAddressesMap = Map<string, Set<string>>;

// reads endpoint configuration from a static file
export class S3WebhookConfigurationProvider implements WebhookConfigurationProvider {
  private log: Logger;
  private endpoints: WebhookConfiguration[];
  private lastUpdatedEndpointsTimestamp: number;

  // try to refetch endpoints every 5 mins
  private static UPDATE_ENDPOINTS_PERIOD_MS = 5 * 60000;

  constructor(_log: Logger, private bucket: string, private key: string) {
    this.endpoints = [];
    this.log = _log.child({ quoter: 'S3WebhookConfigurationProvider' });
    this.lastUpdatedEndpointsTimestamp = Date.now();
  }

  fillers(): string[] {
    return [...new Set(this.endpoints.map((endpoint) => endpoint.hash))];
  }

  fillerEndpoints(): string[] {
    return this.endpoints.map((endpoint) => endpoint.endpoint);
  }

  async addressToFillerHash(): Promise<Map<string, string>> {
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
    const s3Client = new S3Client({});
    const s3Res = await s3Client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
      })
    );
    const s3Body = checkDefined(s3Res.Body, 's3Res.Body is undefined');
    this.endpoints = JSON.parse(await s3Body.transformToString()) as WebhookConfiguration[];
    this.log.info({ endpoints: this.endpoints }, `Fetched ${this.endpoints.length} endpoints from S3`);
  }

  /*
   * Returns the supported protocol versions for the filler at the given endpoint.
   * @param endpoint - The endpoint to check the supported protocol versions for.
   * @returns List of endpoint's supported protocols; defaults to v1 only
   *
   */
  async getFillerSupportedProtocols(endpoint: string): Promise<ProtocolVersion[]> {
    if (
      this.endpoints.length === 0 ||
      Date.now() - this.lastUpdatedEndpointsTimestamp > S3WebhookConfigurationProvider.UPDATE_ENDPOINTS_PERIOD_MS
    ) {
      await this.fetchEndpoints();
      this.lastUpdatedEndpointsTimestamp = Date.now();
    }
    const config = this.endpoints.find((e) => e.endpoint === endpoint);
    return config?.supportedVersions ?? [ProtocolVersion.V1];
  }
}
