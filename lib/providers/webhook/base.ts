import { default as Logger } from 'bunyan';

type WebhookOverrides = {
  timeout: number;
};

export interface WebhookConfiguration {
  name: string;
  hash: string;
  endpoint: string;
  headers?: { [key: string]: string };
  overrides?: WebhookOverrides;
  // the chainids the endpoint should receive webhooks for
  // if null, send for all chains
  chainIds?: number[];
  addresses?: string[];
}

export abstract class WebhookConfigurationProvider {
  protected log: Logger;
  protected endpoints: WebhookConfiguration[];
  protected lastUpdatedEndpointsTimestamp: number;

  constructor(_log: Logger) {
    this.log = _log.child({ quoter: 'WebhookConfigurationProvider' });
    this.endpoints = [];
    this.lastUpdatedEndpointsTimestamp = Date.now();
  }

  fillers(): string[] {
    return [...new Set(this.endpoints.map((endpoint) => endpoint.name))];
  }

  async addressToFiller(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (this.endpoints.length === 0) {
      await this.fetchEndpoints();
    }
    this.endpoints.forEach((endpoint) => {
      endpoint.addresses?.forEach((address) => {
        this.log.info({ address, endpoint }, 'address to filler mapping');
        map.set(address, endpoint.name);
      });
    });
    return map;
  }
  abstract getEndpoints(): Promise<WebhookConfiguration[]>;
  abstract fetchEndpoints(): Promise<void>;
}
