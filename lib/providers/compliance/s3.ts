import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import axios from 'axios';
import { default as Logger } from 'bunyan';

import { FillerComplianceConfiguration, FillerComplianceConfigurationProvider, FillerComplianceList } from '.';
import { checkDefined } from '../../preconditions/preconditions';

export class S3FillerComplianceConfigurationProvider implements FillerComplianceConfigurationProvider {
  private log: Logger;
  private configs: FillerComplianceConfiguration[];
  private endpointToExcludedAddrsMap: Map<string, Set<string>>;
  private lastFetchTime: number;
  private readonly REFRESH_INTERVAL = 5 * 60 * 1000;

  constructor(_log: Logger, private bucket: string, private key: string) {
    this.configs = [];
    this.log = _log.child({ quoter: 'S3FillerComplianceConfigurationProvider' });
    this.endpointToExcludedAddrsMap = new Map<string, Set<string>>();
    this.lastFetchTime = 0;
  }

  private async fetchComplianceList(url: string): Promise<string[]> {
    try {
      const response = await axios.get(url);
      if (response.status !== 200) {
        this.log.warn(
          { url, status: response.status },
          'Failed to fetch compliance list'
        );
        return [];
      }
      const complianceList = response.data as FillerComplianceList;
      return complianceList.addresses;
    } catch (e: any) {
      this.log.warn(
        { url, error: e.message },
        'Error fetching compliance list'
      );
      return [];
    }
  }

  async getEndpointToExcludedAddrsMap(): Promise<Map<string, Set<string>>> {
    const now = Date.now();
    if (this.configs.length === 0 || now - this.lastFetchTime >= this.REFRESH_INTERVAL) {
      await this.fetchConfigs();
      this.endpointToExcludedAddrsMap.clear();
      this.lastFetchTime = now;
    }
    if (this.endpointToExcludedAddrsMap.size > 0) {
      return this.endpointToExcludedAddrsMap;
    }

    // Fetch additional addresses from complianceListUrl for each config
    for (const config of this.configs) {
      if (config.complianceListUrl) {
        const additionalAddresses = await this.fetchComplianceList(config.complianceListUrl);
        config.addresses = [...config.addresses, ...additionalAddresses];
      }
    }

    // Build the endpoint to addresses map
    this.configs.forEach((config) => {
      config.endpoints.forEach((endpoint) => {
        if (!this.endpointToExcludedAddrsMap.has(endpoint)) {
          this.endpointToExcludedAddrsMap.set(endpoint, new Set<string>());
        }
        config.addresses.forEach((address) => {
          this.endpointToExcludedAddrsMap.get(endpoint)?.add(address);
        });
      });
    });

    return this.endpointToExcludedAddrsMap;
  }

  async getConfigs(): Promise<FillerComplianceConfiguration[]> {
    if (this.configs.length === 0) {
      await this.fetchConfigs();
    }
    return this.configs;
  }

  async fetchConfigs(): Promise<void> {
    const s3Client = new S3Client({});
    try {
      const s3Res = await s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.key,
        })
      );
      const s3Body = checkDefined(s3Res.Body, 's3Res.Body is undefined');
      this.configs = JSON.parse(await s3Body.transformToString()) as FillerComplianceConfiguration[];
      this.log.info({ configsLength: this.configs.map((c) => c.addresses.length) }, `Fetched configs`);
    } catch (e: any) {
      this.log.info(
        { name: e.name, message: e.message },
        'Error fetching compliance s3 config. Default to allowing all'
      );
    }
  }
}
