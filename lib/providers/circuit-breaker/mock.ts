import { CircuitBreakerConfigurationProvider, EndpointStatuses } from '.';
import { FillerTimestampMap } from '../../repositories';
import { WebhookConfiguration } from '../webhook';

export class MockV2CircuitBreakerConfigurationProvider implements CircuitBreakerConfigurationProvider {
  constructor(public fillers: string[], private timestamps: FillerTimestampMap) {}

  async getConfigurations(): Promise<FillerTimestampMap> {
    return this.timestamps;
  }

  async getEndpointStatuses(endpoints: WebhookConfiguration[]): Promise<EndpointStatuses> {
    const now = Math.floor(Date.now() / 1000);
    const fillerTimestamps = await this.getConfigurations();
    if (fillerTimestamps.size) {
      const enabledEndpoints = endpoints.filter((e) => {
        return !(fillerTimestamps.has(e.endpoint) && fillerTimestamps.get(e.endpoint)!.blockUntilTimestamp > now);
      });
      const disabledEndpoints = endpoints
        .filter((e) => {
          return fillerTimestamps.has(e.endpoint) && fillerTimestamps.get(e.endpoint)!.blockUntilTimestamp > now;
        })
        .map((e) => {
          return {
            webhook: e,
            blockUntil: fillerTimestamps.get(e.endpoint)!.blockUntilTimestamp,
          };
        });

      return {
        enabled: enabledEndpoints,
        disabled: disabledEndpoints,
      };
    }
    return {
      enabled: endpoints,
      disabled: [],
    };
  }
}
