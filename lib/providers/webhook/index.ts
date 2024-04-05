export * from './mock';
export * from './s3';

type WebhookOverrides = {
  timeout: number;
};

export enum ProtocolVersion {
  V1 = 'v1',
  V2 = 'v2',
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
  addresses?: string[];
  supportedVersions?: ProtocolVersion[];
}

export interface WebhookConfigurationProvider {
  getEndpoints(): Promise<WebhookConfiguration[]>;
}
