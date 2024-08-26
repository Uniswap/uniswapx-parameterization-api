import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Logger from 'bunyan';

import { CircuitBreakerConfigurationProvider, EndpointStatuses } from '.';
import { BaseTimestampRepository, FillerTimestampMap, TimestampRepository } from '../../repositories';
import { WebhookConfiguration } from '../webhook';

export class DynamoCircuitBreakerConfigurationProvider implements CircuitBreakerConfigurationProvider {
  private log: Logger;
  private fillerEndpoints: string[];
  private lastUpdatedTimestamp: number;
  private timestampDB: BaseTimestampRepository;
  private timestamps: FillerTimestampMap = new Map();

  // try to refetch endpoints every 30 seconds
  private static UPDATE_PERIOD_MS = 1 * 30000;

  constructor(_log: Logger, _fillerEndpoints: string[] = []) {
    this.log = _log.child({ quoter: 'CircuitBreakerConfigurationProvider' });
    this.fillerEndpoints = _fillerEndpoints;
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
      this.fillerEndpoints.length === 0 ||
      Date.now() - this.lastUpdatedTimestamp > DynamoCircuitBreakerConfigurationProvider.UPDATE_PERIOD_MS
    ) {
      await this.fetchConfigurations();
      this.lastUpdatedTimestamp = Date.now();
    }
    this.log.info({ timestamps: Array.from(this.timestamps.entries()) }, 'filler timestamps');
    return this.timestamps;
  }

  async fetchConfigurations(): Promise<void> {
    this.timestamps = await this.timestampDB.getFillerTimestampsMap(this.fillerEndpoints);
  }

  /* add filler to `enabled` array if it's not blocked until a future timestamp 
     add disabled fillers and the `blockUntilTimestamp`s to disabled array */
  async getEndpointStatuses(endpoints: WebhookConfiguration[]): Promise<EndpointStatuses> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const fillerTimestamps = await this.getConfigurations();
      if (fillerTimestamps.size) {
        this.log.info({ fillerTimestamps: [...fillerTimestamps.entries()] }, `Circuit breaker config used`);
        const enabledEndpoints = endpoints.filter((e) => {
          return !(fillerTimestamps.has(e.endpoint) && fillerTimestamps.get(e.endpoint)!.blockUntilTimestamp > now);
        });
        const disabledEndpoints = endpoints
          .filter((e) => {
            return fillerTimestamps.has(e.endpoint) && fillerTimestamps.get(e.endpoint)!.blockUntilTimestamp > now;
          })
          .map((e) => {
            return {
              webhook: e,
              blockUntil: fillerTimestamps.get(e.endpoint)!.blockUntilTimestamp,
            };
          });

        this.log.info({ num: enabledEndpoints.length, endpoints: enabledEndpoints }, `Endpoints enabled`);
        this.log.info({ num: disabledEndpoints.length, endpoints: disabledEndpoints }, `Endpoints disabled`);

        return {
          enabled: enabledEndpoints,
          disabled: disabledEndpoints,
        };
      }

      return {
        enabled: endpoints,
        disabled: [],
      };
    } catch (e) {
      this.log.error({ error: e }, `Error getting eligible endpoints, default to returning all`);
      return {
        enabled: endpoints,
        disabled: [],
      };
    }
  }
}
