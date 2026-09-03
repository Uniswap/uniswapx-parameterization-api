import {
  buildExclusionIndex,
  FillerComplianceConfiguration,
  FillerComplianceConfigurationProvider,
  isExcludedIn,
} from '.';

export class MockFillerComplianceConfigurationProvider implements FillerComplianceConfigurationProvider {
  private readonly index;

  constructor(configs: FillerComplianceConfiguration[]) {
    this.index = buildExclusionIndex(configs);
  }

  ensureLoaded(): Promise<void> {
    return Promise.resolve();
  }

  isExcluded(endpoint: string, swapper: string): boolean {
    return isExcludedIn(this.index, endpoint, swapper);
  }
}
