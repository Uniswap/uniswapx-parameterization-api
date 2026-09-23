import Logger from 'bunyan';

import { CircuitBreakerConfigurationProvider, EndpointStatuses } from '.';
import { BaseTimestampRepository, FillerTimestampMap, TimestampRepository } from '../../repositories';
import { WebhookConfiguration } from '../webhook';

export class DynamoCircuitBreakerConfigurationProvider implements CircuitBreakerConfigurationProvider {
  private log: Logger;
  private timestamps: FillerTimestampMap = new Map();
  // The endpoint set `timestamps` was last fetched for. A different set (a filler added to or
  // removed from the webhook config) forces a refetch, so a filler that joins mid-container
  // has its bench state read on the next request instead of being enabled by default.
  private fetchedFor: string | undefined;
  private lastUpdatedTimestamp = 0;

  // try to refetch timestamps every 30 seconds
  private static UPDATE_PERIOD_MS = 1 * 30000;

  // TimestampRepository builds its own wrapNumbers:false client (state is small integers).
  constructor(_log: Logger, private readonly timestampDB: BaseTimestampRepository = TimestampRepository.create()) {
    this.log = _log.child({ quoter: 'CircuitBreakerConfigurationProvider' });
  }

  async getConfigurations(endpoints: string[]): Promise<FillerTimestampMap> {
    const key = endpoints.join('\n');
    if (
      key !== this.fetchedFor ||
      Date.now() - this.lastUpdatedTimestamp > DynamoCircuitBreakerConfigurationProvider.UPDATE_PERIOD_MS
    ) {
      this.timestamps = await this.timestampDB.getFillerTimestampsMap(endpoints);
      this.fetchedFor = key;
      this.lastUpdatedTimestamp = Date.now();
    }
    this.log.info({ timestamps: Array.from(this.timestamps.entries()) }, 'filler timestamps');
    return this.timestamps;
  }

  /* add filler to `enabled` array if it's not blocked until a future timestamp;
      add disabled fillers and the `blockUntilTimestamp`s to disabled array */
  async getEndpointStatuses(endpoints: WebhookConfiguration[]): Promise<EndpointStatuses> {
    if (endpoints.length === 0) {
      return { enabled: [], disabled: [] };
    }
    try {
      const now = Math.floor(Date.now() / 1000);
      // Sorted and deduped: the order-insensitive cache key above, and BatchGet rejects
      // duplicate keys.
      const fillerEndpoints = [...new Set(endpoints.map((e) => e.endpoint))].sort();
      const fillerTimestamps = await this.getConfigurations(fillerEndpoints);
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
