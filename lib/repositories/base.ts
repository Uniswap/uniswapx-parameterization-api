import {
  DescribeStatementCommand,
  ExecuteStatementCommand,
  RedshiftDataClient,
  StatusString,
} from '@aws-sdk/client-redshift-data';
import Logger from 'bunyan';

import { checkDefined } from '../preconditions/preconditions';
import { sleep } from '../util/time';

export type SharedConfigs = {
  Database: string;
  ClusterIdentifier: string;
  SecretArn: string;
};

export type ExecutionConfigs = {
  waitTimeMs: number;
};

export enum TimestampThreshold {
  TWO_WEEKS = "'2 WEEKS'",
  TWO_MONTHS = "'2 MONTHS'",
}

export type TimestampRepoRow = {
  hash: string;
  // Timestamp of the last cron run that examined this filler; boundary for "new since last run".
  lastExaminedTimestamp: number;
  // Block expiry; 0 (UNBLOCKED_BLOCK_UNTIL_TIMESTAMP) when the filler is not blocked.
  blockUntilTimestamp: number;
  // Clean-slate floor for the fade-rate window: only orders completed after this are scored.
  // Set to the block end whenever a block is applied/extended; 0 if the filler was never blocked.
  fadeWindowStart: number;
  consecutiveBlocks: number;
  // Streak of consecutive clean runs (cron runs with >=1 new completion and 0 new fades)
  // while unblocked and escalated. consecutiveBlocks decays one level per
  // CLEAN_RUNS_PER_DECAY of these; any new fade resets the streak, idle runs freeze it.
  consecutiveCleanRuns: number;
};

// Rows round-trip as native numbers now (number-typed attributes read via a wrapNumbers:false
// client), so the raw shape matches TimestampRepoRow — no string parsing.
export type DynamoTimestampRepoRow = TimestampRepoRow;

export type ToUpdateTimestampRow = Omit<
  TimestampRepoRow,
  'blockUntilTimestamp' | 'fadeWindowStart' | 'consecutiveCleanRuns'
> & {
  blockUntilTimestamp?: number;
  fadeWindowStart?: number;
  consecutiveCleanRuns?: number;
};

/*
  fillerHash -> { lastExaminedTimestamp, blockUntilTimestamp, fadeWindowStart, consecutiveBlocks }
*/
export type FillerTimestampMap = Map<string, Omit<TimestampRepoRow, 'hash'>>;

export abstract class BaseRedshiftRepository {
  constructor(readonly client: RedshiftDataClient, private readonly configs: SharedConfigs) {}

  async executeStatement(sql: string, log: Logger, executionConfigs?: ExecutionConfigs): Promise<string> {
    const response = await this.client.send(new ExecuteStatementCommand({ ...this.configs, Sql: sql }));
    const stmtId = checkDefined(response.Id);

    for (;;) {
      const status = await this.client.send(new DescribeStatementCommand({ Id: stmtId }));
      if (status.Error) {
        log.error({ error: status.Error }, 'Failed to execute command');
        throw new Error(status.Error);
      }
      if (status.Status === StatusString.ABORTED || status.Status === StatusString.FAILED) {
        log.error({ error: status.Error }, 'Failed to execute command');
        throw new Error(status.Error);
      } else if (
        status.Status === StatusString.PICKED ||
        status.Status === StatusString.STARTED ||
        status.Status === StatusString.SUBMITTED
      ) {
        await sleep(executionConfigs?.waitTimeMs ?? 2000);
      } else if (status.Status === StatusString.FINISHED) {
        log.info({ sql }, 'Command finished');
        return stmtId;
      } else {
        log.error({ error: status.Error }, 'Unknown status');
        throw new Error(status.Error);
      }
    }
  }
}

export interface BaseTimestampRepository {
  updateTimestampsBatch(toUpdate: ToUpdateTimestampRow[]): Promise<void>;
  getFillerTimestamps(hash: string): Promise<TimestampRepoRow>;
  getFillerTimestampsMap(hashes: string[]): Promise<Map<string, Omit<TimestampRepoRow, 'hash'>>>;
  getTimestampsBatch(hashes: string[]): Promise<TimestampRepoRow[]>;
}
