import { WebhookConfiguration, WebhookConfigurationProvider } from '.';

export class MockWebhookConfigurationProvider implements WebhookConfigurationProvider {
  constructor(private endpoints: WebhookConfiguration[]) {}

  async getEndpoints(): Promise<WebhookConfiguration[]> {
    return this.endpoints;
  }
}
