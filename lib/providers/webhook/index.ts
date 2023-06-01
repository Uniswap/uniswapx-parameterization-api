export * from './mock';
export * from './s3';

type WebhookOverrides = {
  timeout: number;
};

export interface WebhookConfiguration {
  name: string;
  endpoint: string;
  headers?: { [key: string]: string };
  overrides?: WebhookOverrides;
  // the chainids the endpoint should receive webhooks for
  // if null, send for all chains
  chainIds?: number[];
}

export interface WebhookConfigurationProvider {
  getEndpoints(): Promise<WebhookConfiguration[]>;
}
