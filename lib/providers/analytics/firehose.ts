import { Firehose } from 'aws-sdk';
import { AnalyticsEvent } from '../../entities/analytics-events';
import { default as Logger } from 'bunyan';
import { IAnalyticsLogger } from '.';

export class FirehoseLogger implements IAnalyticsLogger {
  private log: Logger;
  private readonly streamName: string;
  private readonly firehose: Firehose;

  constructor(_log: Logger, streamArn: string) {
    this.log = _log;
    // Split the streamArn to extract the streamName
    const streamArnParts = streamArn.split('/');
    
    if (streamArnParts.length !== 2) {
      this.log.error(
        { streamArn: streamArn },
        `Firehose client error parsing stream from ${streamArn}.`
      );
    }

    this.streamName = streamArnParts[1];
    this.firehose = new Firehose();
  }

  async sendAnalyticsEvent(analyticsEvent: AnalyticsEvent): Promise<void> {
    const jsonString = JSON.stringify(analyticsEvent) + '\n';
    const params = {
      DeliveryStreamName: this.streamName,
      Record: {
        Data: jsonString,
      },
    };

    try {
      await this.firehose.putRecord(params).promise();
    } catch (error) {
      this.log.error(
        { streamName: this.streamName },
        `Firehose client error putting record. ${error}`
      );
    }
  }
}
