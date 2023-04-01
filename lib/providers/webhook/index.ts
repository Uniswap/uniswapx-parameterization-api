export * from './env';
export * from './external';
export * from './mock';

export interface WebhookConfiguration {
  endpoint: string;
  headers: { [key: string]: string };
  overrides?: { [key: string]: string };
}

export interface WebhookConfigurationProvider {
  getEndpoints(): Promise<WebhookConfiguration[]>;
}
