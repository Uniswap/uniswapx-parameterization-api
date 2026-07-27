import { WebhookConfiguration } from '../webhook';

export interface EndpointStatuses {
  enabled: WebhookConfiguration[];
  disabled: {
    webhook: WebhookConfiguration;
    blockUntil: number;
  }[];
}

export interface CircuitBreakerConfigurationProvider {
  getEndpointStatuses(endpoints: WebhookConfiguration[]): Promise<EndpointStatuses>;
}
