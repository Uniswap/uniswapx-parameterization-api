import { Firehose } from 'aws-sdk';

const streamArn = process.env.ANALYTICS_STREAM_ARN!;
const parsedStreamName = streamArn.split('/')[1];
const streamName = parsedStreamName ? parsedStreamName : '';

// Define an interface for your analytics event
interface AnalyticsEvent {
  eventType: string;
  eventProperties: {
    [key: string]: any;
  };
}

export async function sendAnalyticsEvent(event: AnalyticsEvent): Promise<{ statusCode: number; body: string }> {
  // Create a Kinesis Data Firehose client
  const firehose = new Firehose();

  // Convert the event object to a JSON string
  const jsonString = JSON.stringify(event);

  // Put a single record into the delivery stream
  const params = {
    DeliveryStreamName: streamName,
    Record: {
      Data: jsonString,
    },
  };

  try {
    await firehose.putRecord(params).promise();
    return { statusCode: 200, body: 'Record put successful' };
  } catch (error) {
    return { statusCode: 500, body: 'Error putting record' };
  }
}