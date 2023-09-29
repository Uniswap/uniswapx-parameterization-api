import { RedshiftDataClient } from '@aws-sdk/client-redshift-data';
import Logger from 'bunyan';

import { BaseRedshiftRepository, SharedConfigs, TimestampThreshold } from './base';

export class AnalyticsRepository extends BaseRedshiftRepository {
  static log: Logger;

  static create(configs: SharedConfigs): AnalyticsRepository {
    this.log = Logger.createLogger({
      name: 'RedshiftRepository',
      serializers: Logger.stdSerializers,
    });

    return new AnalyticsRepository(new RedshiftDataClient({}), configs);
  }

  constructor(readonly client: RedshiftDataClient, configs: SharedConfigs) {
    super(client, configs);
  }

  public async cleanUpTable(
    tableName: string,
    timestampField: string,
    timestampThreshold = TimestampThreshold.TWO_MONTHS
  ): Promise<void> {
    const deleteSql = `
    DELETE FROM ${tableName}
    WHERE ${timestampField} < EXTRACT(EPOCH from (GETDATE() - INTERVAL ${timestampThreshold}))
    `;
    // immediately reclaim storage space, deleting at least 99% of the rows marked for deletion
    const vacuumSql = `VACUUM DELETE ONLY ${tableName} TO 99 PERCENT`;

    await this.executeStatement(deleteSql, AnalyticsRepository.log, { waitTimeMs: 10_000 });
    await this.executeStatement(vacuumSql, AnalyticsRepository.log, { waitTimeMs: 2_000 });
  }
}
