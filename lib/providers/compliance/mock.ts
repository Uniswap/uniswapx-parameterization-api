import { FillerComplianceConfiguration, FillerComplianceConfigurationProvider } from '.';

export class MockFillerComplianceConfigurationProvider implements FillerComplianceConfigurationProvider {
  constructor(private configs: FillerComplianceConfiguration[]) {}

  async getConfigs(): Promise<FillerComplianceConfiguration[]> {
    return this.configs;
  }

  async getAddrToEndpointsMap(): Promise<Map<string, Set<string>>> {
    const addrToEndpointsMap = new Map<string, Set<string>>();
    this.configs.forEach((config) => {
      config.addresses.forEach((address) => {
        if (!addrToEndpointsMap.has(address)) {
          addrToEndpointsMap.set(address, new Set<string>());
        }
        config.endpoints.forEach((endpoint) => {
          addrToEndpointsMap.get(address)?.add(endpoint);
        });
      });
    });
    return addrToEndpointsMap;
  }
}