import { FillerTimestampMap } from '../../repositories';
import { WebhookConfiguration } from '../webhook';

export interface CircuitBreakerConfiguration {
  hash: string;
  fadeRate: number;
  enabled: boolean;
}

export interface EndpointStatuses {
  enabled: WebhookConfiguration[];
  disabled: {
    webhook: WebhookConfiguration;
    blockUntil: number;
    // hashes of the faded orders that caused the block;
    // absent on block entries written before hashes were persisted
    fadedOrderHashes?: string[];
  }[];
}

export interface CircuitBreakerConfigurationProvider {
  allow_list?: Set<string>;
  getConfigurations(): Promise<CircuitBreakerConfiguration[] | FillerTimestampMap>;
  getEndpointStatuses(endpoints: WebhookConfiguration[]): Promise<EndpointStatuses>;
}
