import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Logger from 'bunyan';

import { CircuitBreakerConfigurationProvider } from '.';
import { BaseTimestampRepository, FillerTimestampMap, TimestampRepository } from '../../repositories';

export class DynamoCircuitBreakerConfigurationProvider implements CircuitBreakerConfigurationProvider {
  private log: Logger;
  private fillers: string[];
  private lastUpdatedTimestamp: number;
  private timestampDB: BaseTimestampRepository;
  private timestamps: FillerTimestampMap = new Map();

  // try to refetch endpoints every 30 seconds
  private static UPDATE_PERIOD_MS = 1 * 30000;

  constructor(_log: Logger, fillers: string[] = []) {
    this.log = _log.child({ quoter: 'CircuitBreakerConfigurationProvider' });
    this.fillers = fillers;
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
      this.fillers.length === 0 ||
      Date.now() - this.lastUpdatedTimestamp > DynamoCircuitBreakerConfigurationProvider.UPDATE_PERIOD_MS
    ) {
      await this.fetchConfigurations();
      this.lastUpdatedTimestamp = Date.now();
    }
    this.log.info({ timestamps: Array.from(this.timestamps.entries()) }, 'filler timestamps');
    return this.timestamps;
  }

  async fetchConfigurations(): Promise<void> {
    this.timestamps = await this.timestampDB.getFillerTimestampsMap(this.fillers);
  }
}
