import endpoints from '../../../conf/webhookConfiguration.json';
import { WebhookConfiguration, WebhookConfigurationProvider } from '.';

// reads endpoint configuration from a static file
export class JsonWebhookConfigurationProvider implements WebhookConfigurationProvider {
  async getEndpoints(): Promise<WebhookConfiguration[]> {
    return endpoints;
  }
}
