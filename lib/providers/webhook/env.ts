import Logger from 'bunyan';
import { WebhookConfiguration, WebhookConfigurationProvider } from '.';

// reads endpoint configuration from the environment
export class EnvWebhookConfigurationProvider implements WebhookConfigurationProvider {
  private log: Logger;
  private endpoints: WebhookConfiguration[];

  constructor(_log: Logger) {
    this.log = _log.child({ component: 'JsonWebhookConfigurationProvider' });

    try {
      const envConfig = process.env.RFQ_WEBHOOK_CONFIG;
      if (!envConfig) {
        throw new Error('No RFQ webhook config found');
      }
      this.endpoints = JSON.parse(envConfig);
    } catch (e) {
      this.log.warn('No RFQ webhook config found', e);
      this.endpoints = [];
    }
  }

  async getEndpoints(): Promise<WebhookConfiguration[]> {
    return this.endpoints;
  }
}
