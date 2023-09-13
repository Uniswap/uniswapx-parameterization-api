import { RedshiftDataClient } from '@aws-sdk/client-redshift-data';

export type ExecutionConfigs = {
  waitTimeMs?: number;
};

export interface RedshiftProvider {
  readonly client: RedshiftDataClient;

  executeStatement(sql: string, executionConfigs?: ExecutionConfigs): Promise<void>;
}
