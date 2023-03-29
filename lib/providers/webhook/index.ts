export * from './env';
export * from './json';
export * from './mock';

export interface WebhookConfiguration {
  endpoint: string;
  headers: { [key: string]: string };
}

export interface WebhookConfigurationProvider {
  getEndpoints(): Promise<WebhookConfiguration[]>;
}
