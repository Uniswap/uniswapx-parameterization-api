import { default as Logger } from 'bunyan';

import { WebhookConfiguration, WebhookConfigurationProvider } from './base';

export class MockWebhookConfigurationProvider extends WebhookConfigurationProvider {
  constructor(_log: Logger, _endpoints: WebhookConfiguration[]) {
    super(_log);
    this.endpoints = _endpoints;
  }

  async getEndpoints(): Promise<WebhookConfiguration[]> {
    return this.endpoints;
  }

  async fetchEndpoints(): Promise<void> {
    return;
  }
}
