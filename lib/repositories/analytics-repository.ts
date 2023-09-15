import {
  DescribeStatementCommand,
  ExecuteStatementCommand,
  RedshiftDataClient,
  StatusString,
} from '@aws-sdk/client-redshift-data';
import Logger from 'bunyan';

import { sleep } from '../util/time';
import { BaseAnalyticsRepository, ExecutionConfigs } from './base';

export enum TimestampThreshold {
  ONE_MONTH = "'1 MONTH'",
  TWO_MONTHS = "'2 MONTHS'",
}

export type SharedConfigs = {
  Database: string;
  ClusterIdentifier: string;
  SecretArn: string;
};

export class AnalyticsRepository implements BaseAnalyticsRepository {
  static log: Logger;

  static create(configs: SharedConfigs): AnalyticsRepository {
    this.log = Logger.createLogger({
      name: 'RedshiftRepository',
      serializers: Logger.stdSerializers,
    });

    return new AnalyticsRepository(new RedshiftDataClient({}), configs);
  }

  constructor(readonly client: RedshiftDataClient, private readonly configs: SharedConfigs) {}

  public async cleanUpTable(
    tableName: string,
    timestampField: string,
    timestampThreshold = TimestampThreshold.TWO_MONTHS
  ): Promise<void> {
    const deleteSql = `
    DELETE FROM ${tableName}
    WHERE ${timestampField} < EXTRACT(EPOCH from (GETDATE() - INTERVAL ${timestampThreshold}))
    `;
    // immediately reclaim storage space
    const vacuumSql = `VACUUM DELETE ONLY ${tableName}`;

    await this.executeStatement(deleteSql, { waitTimeMs: 10_000 });
    await this.executeStatement(vacuumSql, { waitTimeMs: 2_000 });
  }

  private async executeStatement(sql: string, executionConfigs?: ExecutionConfigs): Promise<void> {
    const response = await this.client.send(new ExecuteStatementCommand({ ...this.configs, Sql: sql }));
    const stmtId = response.Id;

    for (;;) {
      const status = await this.client.send(new DescribeStatementCommand({ Id: stmtId }));
      if (status.Error) {
        AnalyticsRepository.log.error({ error: status.Error }, 'Failed to execute command');
        throw new Error(status.Error);
      }
      if (status.Status === StatusString.ABORTED || status.Status === StatusString.FAILED) {
        AnalyticsRepository.log.error({ error: status.Error }, 'Failed to execute command');
        throw new Error(status.Error);
      } else if (
        status.Status === StatusString.PICKED ||
        status.Status === StatusString.STARTED ||
        status.Status === StatusString.SUBMITTED
      ) {
        await sleep(executionConfigs?.waitTimeMs ?? 2000);
      } else if (status.Status === StatusString.FINISHED) {
        AnalyticsRepository.log.info({ sql }, 'Command finished');
        break;
      } else {
        AnalyticsRepository.log.error({ error: status.Error }, 'Unknown status');
        throw new Error(status.Error);
      }
    }
  }
}
