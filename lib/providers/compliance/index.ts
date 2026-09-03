export interface FillerComplianceConfiguration {
  endpoints: string[];
  addresses: string[];
}

export interface FillerComplianceConfigurationProvider {
  // The first call per container awaits the load; every later call resolves immediately.
  ensureLoaded(): Promise<void>;
  // Synchronous by design: called once per endpoint on the quote path after ensureLoaded().
  isExcluded(endpoint: string, swapper: string): boolean;
}

// endpoint -> excluded swappers, lowercased on both sides of the comparison so a
// checksum-cased config entry still matches a lowercased request swapper (and vice versa).
export type ExclusionIndex = Map<string, Set<string>>;

export function buildExclusionIndex(configs: FillerComplianceConfiguration[]): ExclusionIndex {
  const index: ExclusionIndex = new Map();
  for (const { endpoints, addresses } of configs) {
    for (const endpoint of endpoints) {
      const excluded = index.get(endpoint) ?? new Set<string>();
      addresses.forEach((address) => excluded.add(address.toLowerCase()));
      index.set(endpoint, excluded);
    }
  }
  return index;
}

export function isExcludedIn(index: ExclusionIndex, endpoint: string, swapper: string): boolean {
  return index.get(endpoint)?.has(swapper.toLowerCase()) ?? false;
}

export * from './mock';
export * from './s3';
