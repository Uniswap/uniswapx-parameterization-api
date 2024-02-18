import { FillerTimestampMap } from '../../repositories';

export interface CircuitBreakerConfigurationProvider {
  getConfigurations(): Promise<FillerTimestampMap>;
}
