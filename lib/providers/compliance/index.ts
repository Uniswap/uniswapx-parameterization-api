export interface FillerComplianceConfiguration {
  endpoints: string[];
  addresses: string[];
}

export interface FillerComplianceConfigurationProvider {
  getConfigs(): Promise<FillerComplianceConfiguration[]>;
  getAddrToEndpointsMap(): Promise<Map<string, Set<string>>>;
}

export * from './mock';
export * from './s3';