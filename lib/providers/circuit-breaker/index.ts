export interface CircuitBreakerConfiguration {
  name: string;
  enabled: boolean;
}

export interface CircuitBreakerConfigurationProvider {
  getConfigurations(): Promise<CircuitBreakerConfiguration[]>;
}
