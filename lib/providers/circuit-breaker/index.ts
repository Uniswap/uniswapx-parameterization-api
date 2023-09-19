export interface CircuitBreakerConfiguration {
  name: string;
  fadeRate: number;
  enabled: boolean;
}

export interface CircuitBreakerConfigurationProvider {
  getConfigurations(): Promise<CircuitBreakerConfiguration[]>;
}
