import { CircuitBreakerConfiguration, CircuitBreakerConfigurationProvider } from '.';

export class MockCircuitBreakerConfigurationProvider implements CircuitBreakerConfigurationProvider {
  constructor(private config: CircuitBreakerConfiguration[]) {}

  async getConfigurations(): Promise<CircuitBreakerConfiguration[]> {
    return this.config;
  }
}
