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
  }[];
}

export interface CircuitBreakerConfigurationProvider {
  allow_list?: Set<string>;
  getConfigurations(): Promise<CircuitBreakerConfiguration[] | FillerTimestampMap>;
  getEndpointStatuses(endpoints: WebhookConfiguration[]): Promise<EndpointStatuses>;
}
