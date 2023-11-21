import { AnalyticsEvent } from '../../entities';

export interface IAnalyticsLogger {
  sendAnalyticsEvent(analyticsEvent: AnalyticsEvent): Promise<void>;
}

export * from './firehose';
