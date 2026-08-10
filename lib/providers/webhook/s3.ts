import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { metric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import { default as Logger } from 'bunyan';

import { WebhookConfiguration, WebhookConfigurationProvider } from '.';
import { Metric } from '../../entities/aws-metrics-logger';
import { checkDefined } from '../../preconditions/preconditions';

// reads endpoint configuration from a static file
export class S3WebhookConfigurationProvider implements WebhookConfigurationProvider {
  private log: Logger;
  private endpoints: WebhookConfiguration[];
  private lastUpdatedEndpointsTimestamp: number;
  // signature of the last successfully fetched config; undefined until first fetch
  private configSignature?: string;

  // try to refetch endpoints every 5 mins
  private static UPDATE_ENDPOINTS_PERIOD_MS = 5 * 60000;

  constructor(_log: Logger, private bucket: string, private key: string) {
    this.endpoints = [];
    this.log = _log.child({ quoter: 'S3WebhookConfigurationProvider' });
    this.lastUpdatedEndpointsTimestamp = Date.now();
  }

  fillerEndpoints(): string[] {
    return this.endpoints.map((endpoint) => endpoint.endpoint);
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
    const previousNames = new Set(this.endpoints.map((e) => e.name));
    this.endpoints = JSON.parse(await s3Body.transformToString()) as WebhookConfiguration[];
    this.log.info({ endpoints: this.endpoints }, `Fetched ${this.endpoints.length} endpoints from S3`);
    this.detectConfigChange(previousNames);
  }

  /**
   * Marks RFQ config changes on the latency dashboard. The config is edited outside
   * this repo (S3, via the config repo), so git-derived deploy markers cannot see
   * filler adds/removals — but this service refetches the config it consumes, so it
   * can observe every change itself. Only an observed change between two fetches on
   * the same instance counts; the first fetch after a cold start does not (otherwise
   * every scale-up would look like a config change).
   */
  private detectConfigChange(previousNames: Set<string>): void {
    // order-insensitive signature over the fields that define an endpoint's identity
    // and reachability; header values are deliberately excluded from logs but any
    // change to them still flips the signature via JSON of the full entries
    const signature = JSON.stringify(
      [...this.endpoints].sort((a, b) => a.endpoint.localeCompare(b.endpoint)).map((e) => ({ ...e }))
    );
    const previousSignature = this.configSignature;
    this.configSignature = signature;
    if (previousSignature === undefined || previousSignature === signature) return;

    metric.putMetric(Metric.RFQ_CONFIG_CHANGED, 1, MetricLoggerUnit.Count);
    const currentNames = new Set(this.endpoints.map((e) => e.name));
    const added = [...currentNames].filter((n) => !previousNames.has(n));
    const removed = [...previousNames].filter((n) => !currentNames.has(n));
    this.log.info(
      { added, removed, endpointCount: this.endpoints.length },
      `RFQ config changed: +${added.length} -${removed.length} fillers`
    );
  }
}
