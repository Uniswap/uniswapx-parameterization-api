import { v4 as uuidv4 } from 'uuid';
import { timestampInMstoISOString } from '../util/time';

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
  eventId: string; // gets set in constructor
  eventType: AnalyticsEventType;
  eventTime: string; // gets set in constructor
  eventProperties: { [key: string]: any };

  constructor(eventType: AnalyticsEventType, eventProperties: { [key: string]: any }) {
    this.eventId = uuidv4();
    this.eventType = eventType;
    this.eventTime = timestampInMstoISOString(Date.now());
    this.eventProperties = eventProperties;
  }
};
