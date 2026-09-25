import { AnalyticsEvent } from '../../lib/entities';
import { IAnalyticsLogger } from '../../lib/providers/analytics';

/** Records every analytics event instead of sending it to Firehose. */
export class FakeAnalyticsLogger implements IAnalyticsLogger {
  public readonly events: AnalyticsEvent[] = [];

  public async sendAnalyticsEvent(analyticsEvent: AnalyticsEvent): Promise<void> {
    this.events.push(analyticsEvent);
  }

  public reset(): void {
    this.events.length = 0;
  }
}
