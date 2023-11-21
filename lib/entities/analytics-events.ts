export enum AnalyticsEventType {
  WEBHOOK_RESPONSE = 'WebhookQuoterResponse',
};

export enum WebhookResponseType {
  OK = 'OK',
  NON_QUOTE = 'NON_QUOTE',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  REQUEST_ID_MISMATCH = 'REQUEST_ID_MISMATCH',
  TIMEOUT = 'TIMEOUT',
  HTTP_ERROR = 'HTTP_ERROR',
  OTHER_ERROR = 'OTHER_ERROR',
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
