import { FillerTimestampMap } from '../../repositories';
import { WebhookConfiguration } from '../webhook';

export interface CircuitBreakerConfiguration {
  hash: string;
  fadeRate: number;
  enabled: boolean;
}

export interface CircuitBreakerConfigurationProvider {
  allow_list?: Set<string>;
  getConfigurations(): Promise<CircuitBreakerConfiguration[] | FillerTimestampMap>;
  getEligibleEndpoints(endpoints: WebhookConfiguration[]): Promise<WebhookConfiguration[]>;
}
