import Logger from 'bunyan';
import { WebhookConfiguration, WebhookConfigurationProvider } from '.';

// reads endpoint configuration from the environment
export class EnvWebhookConfigurationProvider implements WebhookConfigurationProvider {
  private log: Logger;
  private endpoints: WebhookConfiguration[];

  constructor(config: string | undefined, _log: Logger) {
    this.log = _log.child({ component: 'JsonWebhookConfigurationProvider' });

    try {
      if (!config) {
        throw new Error('No RFQ webhook config found');
      }
      this.endpoints = JSON.parse(config);
    } catch (e) {
      this.log.warn('No RFQ webhook config found', e);
      this.endpoints = [];
    }
  }

  async getEndpoints(): Promise<WebhookConfiguration[]> {
    return this.endpoints;
  }
}
