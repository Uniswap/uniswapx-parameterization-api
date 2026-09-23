import { Context } from '../../observability';

export * from './mock';
export * from './s3';

type WebhookOverrides = {
  timeout: number;
};

export enum ProtocolVersion {
  V1 = 'v1',
  V2 = 'v2',
  V3 = 'v3',
}

export interface WebhookConfiguration {
  name: string;
  hash: string;
  endpoint: string;
  headers?: { [key: string]: string };
  overrides?: WebhookOverrides;
  // the chainids the endpoint should receive webhooks for
  // if null, send for all chains
  chainIds?: number[];
  supportedVersions?: ProtocolVersion[];
}

export interface WebhookConfigurationProvider {
  // ctx carries the caller's metrics: a refresh triggered by a quote request reports through
  // that request, one triggered by the cron through the cron run.
  getEndpoints(ctx: Context): Promise<WebhookConfiguration[]>;
}
