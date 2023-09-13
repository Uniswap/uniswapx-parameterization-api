import { RedshiftDataClient } from '@aws-sdk/client-redshift-data';

import { SynthSwitchQueryParams, SynthSwitchTrade } from '../handlers/synth-switch';
import { TimestampThreshold } from './analytics-repository';

export type ExecutionConfigs = {
  waitTimeMs: number;
};

export interface BaseSwitchRepository {
  putSynthSwitch(trade: SynthSwitchTrade, lower: string, enabled: boolean): Promise<void>;
  syntheticQuoteForTradeEnabled(trade: SynthSwitchQueryParams): Promise<boolean>;
}

export interface BaseAnalyticsRepository {
  readonly client: RedshiftDataClient;
  cleanUpTable(tableName: string, timestampField: string, timestampThreshold: TimestampThreshold): Promise<void>;
}
