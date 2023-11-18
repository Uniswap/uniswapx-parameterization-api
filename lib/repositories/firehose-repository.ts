import { Firehose } from 'aws-sdk';
import { AnalyticsEvent, AnalyticsEventType } from '../entities/analytics-events';

export class FirehoseLogger {
  private readonly streamName: string;
  private readonly firehose: Firehose;
  private readonly isMock: boolean;

  constructor(streamArn: string, isMock: boolean = false) {
    // Split the streamArn to extract the streamName
    const streamArnParts = streamArn.split('/');
    if (streamArnParts.length !== 2) {
      throw new Error('Invalid ANALYTICS_STREAM_ARN environment variable');
    }
    this.streamName = streamArnParts[1];
    this.firehose = new Firehose();
    this.isMock = isMock;
  }
 
  async sendAnalyticsEvent(
    eventData: {
      eventType: AnalyticsEventType;
      eventProperties: { [key: string]: any };
    }
  ): Promise<{ statusCode: number; body: string }> {
    const { eventType, eventProperties } = eventData;
    const analyticsEvent = new AnalyticsEvent(eventType, eventProperties);

    if (this.isMock) {
      return { statusCode: 200, body: 'Record put successful in mock' };
    }

    const jsonString = JSON.stringify(analyticsEvent) + '\n';
    const params = {
      DeliveryStreamName: this.streamName,
      Record: {
        Data: jsonString,
      },
    };

    try {
      await this.firehose.putRecord(params).promise();
      return { statusCode: 200, body: 'Record put successful' };
    } catch (error) {
      return { statusCode: 500, body: 'Error putting record' };
    }
  }
}