export enum AnalyticsEventType {
  WEBHOOK_RESPONSE = 'WebhookQuoterResponse',
};

export class AnalyticsEvent {
  eventType: AnalyticsEventType;
  eventTime?: number; // gets set in constructor
  eventProperties: { [key: string]: any };

  constructor(eventType: AnalyticsEventType, eventProperties: { [key: string]: any }) {
    this.eventType = eventType;
    this.eventTime = Date.now();
    this.eventProperties = eventProperties;
  }
};