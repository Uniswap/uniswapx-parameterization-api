import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Logger from 'bunyan';

import { CircuitBreakerConfigurationProvider } from '.';
import { BaseTimestampRepository, FillerTimestampMap, TimestampRepository } from '../../repositories';
import { WebhookConfiguration } from '../webhook';

export class DynamoCircuitBreakerConfigurationProvider implements CircuitBreakerConfigurationProvider {
  private log: Logger;
  private fillerHashes: string[];
  private lastUpdatedTimestamp: number;
  private timestampDB: BaseTimestampRepository;
  private timestamps: FillerTimestampMap = new Map();
  allow_list: Set<string> = new Set<string>();

  // try to refetch endpoints every 30 seconds
  private static UPDATE_PERIOD_MS = 1 * 30000;

  constructor(_log: Logger, _fillerHashes: string[] = []) {
    this.log = _log.child({ quoter: 'CircuitBreakerConfigurationProvider' });
    this.fillerHashes = _fillerHashes;
    this.lastUpdatedTimestamp = Date.now();
    const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: {
        convertEmptyValues: true,
      },
      unmarshallOptions: {
        wrapNumbers: true,
      },
    });
    this.timestampDB = TimestampRepository.create(documentClient);
  }

  async getConfigurations(): Promise<FillerTimestampMap> {
    if (
      this.fillerHashes.length === 0 ||
      Date.now() - this.lastUpdatedTimestamp > DynamoCircuitBreakerConfigurationProvider.UPDATE_PERIOD_MS
    ) {
      await this.fetchConfigurations();
      this.lastUpdatedTimestamp = Date.now();
    }
    this.log.info({ timestamps: Array.from(this.timestamps.entries()) }, 'filler timestamps');
    return this.timestamps;
  }

  async fetchConfigurations(): Promise<void> {
    this.timestamps = await this.timestampDB.getFillerTimestampsMap(this.fillerHashes);
  }

  /* add filler if it's not blocked until a future timestamp */
  async getEligibleEndpoints(endpoints: WebhookConfiguration[]): Promise<WebhookConfiguration[]> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const fillerTimestamps = await this.getConfigurations();
      if (fillerTimestamps.size) {
        this.log.info({ fillerTimestamps: [...fillerTimestamps.entries()] }, `Circuit breaker config used`);
        const enabledEndpoints: WebhookConfiguration[] = [];
        endpoints.forEach((e) => {
          if (
            !fillerTimestamps.has(e.hash) ||
            (fillerTimestamps.has(e.hash) &&
              (fillerTimestamps.get(e.hash)!.blockUntilTimestamp < now ||
                isNaN(fillerTimestamps.get(e.hash)!.blockUntilTimestamp)))
          ) {
            enabledEndpoints.push(e);
          }
        });
        this.log.info({ endpoints: enabledEndpoints }, `Endpoint enabled`);
        return enabledEndpoints;
      }

      return endpoints;
    } catch (e) {
      this.log.error({ error: e }, `Error getting eligible endpoints, default to returning all`);
      return endpoints;
    }
  }
}
