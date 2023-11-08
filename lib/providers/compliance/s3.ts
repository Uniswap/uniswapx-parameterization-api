
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { default as Logger } from 'bunyan';

import { checkDefined } from '../../preconditions/preconditions';
import { FillerComplianceConfiguration, FillerComplianceConfigurationProvider } from '.';


export class S3FillerComplianceConfigurationProvider implements FillerComplianceConfigurationProvider {
  private log: Logger;
  private configs: FillerComplianceConfiguration[];
  private addrToEndpointsMap: Map<string, Set<string>>;

  constructor(_log: Logger, private bucket: string, private key: string) {
    this.configs = [];
    this.log = _log.child({ quoter: 'S3FillerComplianceConfigurationProvider' });
    this.addrToEndpointsMap = new Map<string, Set<string>>();
  }

  async getAddrToEndpointsMap(): Promise<Map<string, Set<string>>> {
    if (this.configs.length === 0) {
      await this.fetchConfigs();
    }
    if (this.addrToEndpointsMap.size === 0) {
      this.configs.forEach((config) => {
        config.addresses.forEach((address) => {
          if (!this.addrToEndpointsMap.has(address)) {
            this.addrToEndpointsMap.set(address, new Set<string>());
          }
          config.endpoints.forEach((endpoint) => {
            this.addrToEndpointsMap.get(address)?.add(endpoint);
          });
        });
      })
    }
    return this.addrToEndpointsMap;
  }

  async getConfigs(): Promise<FillerComplianceConfiguration[]> {
    if (
      this.configs.length === 0
    ) {
      await this.fetchConfigs();
    }
    return this.configs;
  }

  async fetchConfigs(): Promise<void> {
    const s3Client = new S3Client({});
    const s3Res = await s3Client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
      })
    );
    const s3Body = checkDefined(s3Res.Body, 's3Res.Body is undefined');
    this.configs = JSON.parse(await s3Body.transformToString()) as FillerComplianceConfiguration[];
    this.log.info({ configsLength: this.configs.map((c) => c.addresses.length) }, `Fetched configs`);
  }
}