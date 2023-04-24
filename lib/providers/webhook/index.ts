export * from './mock';
export * from './s3';

export interface WebhookConfiguration {
  endpoint: string;
  headers?: { [key: string]: string };
  overrides?: { [key: string]: string };
}

export interface WebhookConfigurationProvider {
  getEndpoints(): Promise<WebhookConfiguration[]>;
}
