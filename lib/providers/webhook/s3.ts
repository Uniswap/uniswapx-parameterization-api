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
    // Raw reference only — the previous payload is as unvalidated as the new one,
    // so every dereference of it belongs inside detectConfigChange's guard.
    const previousEndpoints = this.endpoints;
    this.endpoints = JSON.parse(await s3Body.transformToString()) as WebhookConfiguration[];
    this.log.info({ endpoints: this.endpoints }, `Fetched ${this.endpoints.length} endpoints from S3`);
    this.detectConfigChange(previousEndpoints);
  }

  /**
   * Marks RFQ config changes on the latency dashboard. The config is edited outside
   * this repo (S3, via the config repo), so git-derived deploy markers cannot see
   * filler adds/removals — but this service refetches the config it consumes, so it
   * can observe every change itself. Only an observed change between two fetches on
   * the same instance counts; the first fetch after a cold start does not (otherwise
   * every scale-up would look like a config change).
   *
   * Best-effort by construction: this is observability on the hot quote path, so it
   * must never throw — a malformed config entry degrades to "no marker", not a 500.
   */
  private detectConfigChange(previousEndpoints: WebhookConfiguration[]): void {
    try {
      const signature = configSignature(this.endpoints);
      const previousSignature = this.configSignature;
      this.configSignature = signature;
      if (previousSignature === undefined || previousSignature === signature) return;

      metric.putMetric(Metric.RFQ_CONFIG_CHANGED, 1, MetricLoggerUnit.Count);
      // null-safe: both payloads are unvalidated S3 JSON and may contain null or
      // name-less entries
      const toNames = (endpoints: WebhookConfiguration[]) => new Set(endpoints.map((e) => String(e?.name ?? '')));
      const currentNames = toNames(this.endpoints);
      const previousNames = toNames(previousEndpoints);
      const added = [...currentNames].filter((n) => !previousNames.has(n));
      const removed = [...previousNames].filter((n) => !currentNames.has(n));
      this.log.info(
        { added, removed, endpointCount: this.endpoints.length },
        `RFQ config changed: +${added.length} -${removed.length} fillers`
      );
    } catch (e) {
      this.log.warn({ err: `${e}` }, 'config change detection failed; skipping marker for this refresh');
    }
  }
}

/**
 * Canonical signature over exactly the fields that change fan-out membership or
 * behavior: which fillers exist, where they are reached, on which chains/protocols,
 * and with what timeout. A fixed field projection in a fixed order makes the
 * signature immune to false positives from key reordering, unknown/extra fields,
 * or entry order in the S3 JSON. Header (auth) rotations are deliberately excluded:
 * they don't change fan-out shape and would paint misleading change markers.
 * Null-safe throughout — entries are unvalidated S3 payload.
 */
export function configSignature(endpoints: WebhookConfiguration[]): string {
  const canonical = [...endpoints]
    .map((e) => [
      String(e?.name ?? ''),
      String(e?.endpoint ?? ''),
      [...(e?.chainIds ?? [])].sort((a, b) => a - b),
      [...(e?.supportedVersions ?? [])].sort(),
      e?.overrides?.timeout ?? null,
    ])
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  return JSON.stringify(canonical);
}
