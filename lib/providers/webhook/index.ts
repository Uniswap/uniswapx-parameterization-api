export * from './mock';
export * from './s3';

type WebhookOverrides = {
  timeout: number;
};

export interface WebhookConfiguration {
  endpoint: string;
  headers?: { [key: string]: string };
  overrides?: WebhookOverrides;
}

export interface WebhookConfigurationProvider {
  getEndpoints(): Promise<WebhookConfiguration[]>;
}
