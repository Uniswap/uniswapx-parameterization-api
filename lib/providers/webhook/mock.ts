import { WebhookConfiguration, WebhookConfigurationProvider } from '.';
import { Context } from '../../observability';

export class MockWebhookConfigurationProvider implements WebhookConfigurationProvider {
  constructor(private endpoints: WebhookConfiguration[]) {}

  async getEndpoints(_ctx: Context): Promise<WebhookConfiguration[]> {
    return this.endpoints;
  }
}
