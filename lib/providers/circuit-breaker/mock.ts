import { CircuitBreakerConfiguration, CircuitBreakerConfigurationProvider } from '.';
import { FillerTimestampMap } from '../../repositories';
import { WebhookConfiguration } from '../webhook';

export class MockV2CircuitBreakerConfigurationProvider implements CircuitBreakerConfigurationProvider {
  constructor(public fillers: string[], private timestamps: FillerTimestampMap) {}

  async getConfigurations(): Promise<FillerTimestampMap> {
    return this.timestamps;
  }

  async getEligibleEndpoints(endpoints: WebhookConfiguration[]): Promise<WebhookConfiguration[]> {
    const now = Math.floor(Date.now() / 1000);
    const fillerTimestamps = await this.getConfigurations();
    if (fillerTimestamps.size) {
      const enabledEndpoints = endpoints.filter((e) => {
        return !(fillerTimestamps.has(e.endpoint) && fillerTimestamps.get(e.endpoint)!.blockUntilTimestamp > now);
      });
      return enabledEndpoints;
    }
    return endpoints;
  }
}

export class MockCircuitBreakerConfigurationProvider implements CircuitBreakerConfigurationProvider {
  allow_list: Set<string>;

  constructor(private config: CircuitBreakerConfiguration[], _allow_list: Set<string> = new Set<string>([])) {
    this.allow_list = _allow_list;
  }

  async getConfigurations(): Promise<CircuitBreakerConfiguration[]> {
    return this.config;
  }

  async getEligibleEndpoints(endpoints: WebhookConfiguration[]): Promise<WebhookConfiguration[]> {
    const fillerToConfigMap = new Map(this.config.map((c) => [c.hash, c]));
    const enabledEndpoints: WebhookConfiguration[] = [];
    endpoints.forEach((e) => {
      if (
        this.allow_list.has(e.hash) ||
        (fillerToConfigMap.has(e.hash) && fillerToConfigMap.get(e.hash)?.enabled) ||
        !fillerToConfigMap.has(e.hash) // default to allowing fillers not in the config
      ) {
        enabledEndpoints.push(e);
      }
    });
    return enabledEndpoints;
  }
}
