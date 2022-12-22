import { WebhookConfigurationProvider } from '.';

export class MockWebhookConfigurationProvider implements WebhookConfigurationProvider {
  constructor(private endpoints: string[]) {}

  async getEndpoints(): Promise<string[]> {
    return this.endpoints;
  }
}
