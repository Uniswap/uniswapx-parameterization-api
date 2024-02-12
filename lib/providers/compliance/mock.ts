import { FillerComplianceConfiguration, FillerComplianceConfigurationProvider } from '.';

export class MockFillerComplianceConfigurationProvider implements FillerComplianceConfigurationProvider {
  constructor(private configs: FillerComplianceConfiguration[]) {}

  async getConfigs(): Promise<FillerComplianceConfiguration[]> {
    return this.configs;
  }

  async getEndpointToExcludedAddrsMap(): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    this.configs.forEach((config) => {
      config.endpoints.forEach((endpoint) => {
        if (!map.has(endpoint)) {
          map.set(endpoint, new Set<string>());
        }
        config.addresses.forEach((address) => {
          map.get(endpoint)?.add(address);
        });
      });
    });
    return map;
  }
}
