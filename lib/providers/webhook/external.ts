import { WebhookConfiguration, WebhookConfigurationProvider } from '.';

// reads endpoint configuration from a static file
export class ExternalWebhookConfigurationProvider implements WebhookConfigurationProvider {
  constructor(private endpoints: WebhookConfiguration[]) {}
  async getEndpoints(): Promise<WebhookConfiguration[]> {
    return this.endpoints;
  }
}
