import { GetObjectCommand } from '@aws-sdk/client-s3';
import { default as Logger } from 'bunyan';

import {
  buildExclusionIndex,
  ExclusionIndex,
  FillerComplianceConfiguration,
  FillerComplianceConfigurationProvider,
  isExcludedIn,
} from '.';
import { checkDefined } from '../../preconditions/preconditions';
import { createConfigS3Client } from '../../util/config-s3-client';

export const COMPLIANCE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// The slice of S3Client this provider uses, typed structurally so tests can inject a fake.
export interface ComplianceS3Client {
  send(command: GetObjectCommand): Promise<{ Body?: { transformToString(): Promise<string> } }>;
}

// Stale-while-revalidate: the first call per container awaits one bounded fetch; after that a
// call that finds the interval elapsed starts a single background refresh and keeps serving the
// current index, which is swapped atomically when the fetch completes. The fetch stays on the
// request path (not container init) because of a Dec-2024 S3 clock-skew issue.
export class S3FillerComplianceConfigurationProvider implements FillerComplianceConfigurationProvider {
  private readonly log: Logger;
  private index: ExclusionIndex = new Map();
  // Tracked explicitly: an empty config (prod today) is a loaded config, not a missing one.
  private loaded = false;
  private lastFetchTime = 0;
  private inflight: Promise<void> | undefined;

  constructor(
    _log: Logger,
    private readonly bucket: string,
    private readonly key: string,
    private readonly s3Client: ComplianceS3Client = createConfigS3Client()
  ) {
    this.log = _log.child({ quoter: 'S3FillerComplianceConfigurationProvider' });
  }

  async ensureLoaded(): Promise<void> {
    if (Date.now() - this.lastFetchTime >= COMPLIANCE_REFRESH_INTERVAL_MS && !this.inflight) {
      this.inflight = this.fetchConfigs().finally(() => (this.inflight = undefined));
    }
    if (!this.loaded) await this.inflight;
  }

  isExcluded(endpoint: string, swapper: string): boolean {
    return isExcludedIn(this.index, endpoint, swapper);
  }

  private async fetchConfigs(): Promise<void> {
    try {
      const s3Res = await this.s3Client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key }));
      const s3Body = checkDefined(s3Res.Body, 's3Res.Body is undefined');
      const configs = JSON.parse(await s3Body.transformToString()) as FillerComplianceConfiguration[];
      this.index = buildExclusionIndex(configs);
      this.log.info({ configsLength: configs.map((c) => c.addresses.length) }, 'Fetched configs');
    } catch (e) {
      // Fails open on the last good index (or an empty one); the next attempt waits for the interval.
      const { name, message } = e instanceof Error ? e : { name: 'UnknownError', message: String(e) };
      this.log.warn({ name, message }, 'Error fetching compliance s3 config. Default to allowing all');
    } finally {
      this.loaded = true;
      this.lastFetchTime = Date.now();
    }
  }
}
