import { CircuitBreakerConfigurationProvider } from '.';
import { FillerTimestampMap } from '../../repositories';

export class MockCircuitBreakerConfigurationProvider implements CircuitBreakerConfigurationProvider {
  constructor(public fillers: string[], private timestamps: FillerTimestampMap) {}

  async getConfigurations(): Promise<FillerTimestampMap> {
    return this.timestamps;
  }
}
