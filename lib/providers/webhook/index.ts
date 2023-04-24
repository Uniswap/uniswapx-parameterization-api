export * from './json';
export * from './mock';

export type WebhookConfigurationHeaders = {
  'CF-Access-Client-Id'?: string;
  'CF-Access-Client-Secret'?: string;
  Authorization?: string;
};

export interface WebhookConfiguration {
  endpoint: string;
  headers?: WebhookConfigurationHeaders;
}

export interface WebhookConfigurationProvider {
  getEndpoints(): Promise<WebhookConfiguration[]>;
}
