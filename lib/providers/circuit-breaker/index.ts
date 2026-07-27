import { WebhookConfiguration } from '../webhook';

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
  getEndpointStatuses(endpoints: WebhookConfiguration[]): Promise<EndpointStatuses>;
}
