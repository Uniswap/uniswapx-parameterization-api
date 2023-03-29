import { WebhookConfiguration, WebhookConfigurationProvider } from '.';
import endpoints from '../../../conf/webhookConfiguration.json';

// reads endpoint configuration from a static file
export class JsonWebhookConfigurationProvider implements WebhookConfigurationProvider {
  async getEndpoints(): Promise<WebhookConfiguration[]> {
    return endpoints;
  }
}
