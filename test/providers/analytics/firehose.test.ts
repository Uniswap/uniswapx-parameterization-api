import { FirehoseLogger } from '../../../lib/providers/analytics';
import { AnalyticsEvent, AnalyticsEventType } from '../../../lib/entities/analytics-events';
import { Firehose } from 'aws-sdk';

jest.mock('aws-sdk');

const mockedFirehose = Firehose as jest.Mocked<typeof Firehose>;

const logger = { error: jest.fn() } as any;

describe('FirehoseLogger', () => {
  const invalidStreamArn = 'dummy-stream';
  const validStreamArn = 'arn:aws:firehose:region:account-id:deliverystream/stream-name';

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('logs an error with an invalid streamArn constructor arg', async () => {
    new FirehoseLogger(logger, invalidStreamArn);
    expect(logger.error).toHaveBeenCalledWith(
      { streamArn: invalidStreamArn },
      expect.stringContaining(`Firehose client error parsing stream from ${invalidStreamArn}.`)
    );
  });

  it('initializes Firehose client with the correct stream name', async () => {
    const firehose = new FirehoseLogger(logger, validStreamArn);
    expect(logger.error).not.toHaveBeenCalledWith(
      { streamArn: validStreamArn },
      expect.stringContaining(`Firehose client error parsing stream from ${validStreamArn}.`)
    );
    expect(firehose).toBeInstanceOf(FirehoseLogger);
    expect(firehose['streamName']).toBe('stream-name');
  });

  it('should send analytics event to Firehose', async () => {
    const firehose = new FirehoseLogger(logger, validStreamArn);
    const analyticsEvent: AnalyticsEvent = { eventType: AnalyticsEventType.WEBHOOK_RESPONSE, eventProperties: { status: 200 } };

    const putRecordMock = jest.fn();
    mockedFirehose.prototype.putRecord = putRecordMock;

    putRecordMock.mockImplementationOnce((_params, callback) => {
      callback(null, { "Encrypted": true, "RecordId": "123" });
    });

    await firehose.sendAnalyticsEvent(analyticsEvent);

    expect(putRecordMock).toHaveBeenCalledWith({
      DeliveryStreamName: 'stream-name',
      Record: {
        Data: JSON.stringify(analyticsEvent) + '\n',
      },
    });
  });
});
