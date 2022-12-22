export * from './json';
export * from './mock';

export interface WebhookConfigurationProvider {
  getEndpoints(): Promise<string[]>;
}
