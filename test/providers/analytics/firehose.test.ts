import { FirehoseClient } from '@aws-sdk/client-firehose';

import { AnalyticsEvent, AnalyticsEventType } from '../../../lib/entities/analytics-events';
import { FirehoseLogger } from '../../../lib/providers/analytics';

const mockedFirehose = FirehoseClient as jest.Mocked<typeof FirehoseClient>;

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
    const analyticsEvent = new AnalyticsEvent(AnalyticsEventType.WEBHOOK_RESPONSE, { status: 200 });

    const putRecordMock = jest.fn();
    mockedFirehose.prototype.send = putRecordMock;

    //putRecordMock.mockImplementationOnce((_input: PutRecordCommandInput) => {
    //  return;
    //});

    await firehose.sendAnalyticsEvent(analyticsEvent);

    const input = {
      DeliveryStreamName: 'stream-name',
      Record: {
        Data: Buffer.from(JSON.stringify(analyticsEvent) + '\n', 'base64'),
      },
    };

    expect(putRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: input,
      })
    );
  });
});
