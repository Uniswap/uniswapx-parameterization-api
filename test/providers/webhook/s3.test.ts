import { S3Client } from '@aws-sdk/client-s3';
import { metric } from '@uniswap/smart-order-router';
import { default as Logger } from 'bunyan';

import { Metric } from '../../../lib/entities';
import { S3WebhookConfigurationProvider, WebhookConfiguration } from '../../../lib/providers';

const mockEndpoints = [
  {
    name: 'google',
    endpoint: 'https://google.com',
    headers: {
      'x-api-key': '1234',
    },
    hash: '0xgoogle',
  },
  {
    name: 'meta',
    endpoint: 'https://meta.com',
    hash: '0xmeta',
  },
];

function applyMock(endpoints: WebhookConfiguration[]) {
  jest.spyOn(S3Client.prototype, 'send').mockImplementationOnce(() =>
    Promise.resolve({
      Body: {
        transformToString: () => Promise.resolve(JSON.stringify(endpoints)),
      },
    })
  );
}

// silent logger in tests
const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

describe('S3WebhookConfigurationProvider', () => {
  const bucket = 'test-bucket';
  const key = 'test-key';

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('Fetches endpoints', async () => {
    applyMock(mockEndpoints);
    const provider = new S3WebhookConfigurationProvider(logger, bucket, key);
    const endpoints = await provider.getEndpoints();
    expect(endpoints).toEqual(mockEndpoints);
  });

  it('Caches fetched endpoints', async () => {
    applyMock(mockEndpoints);
    const provider = new S3WebhookConfigurationProvider(logger, bucket, key);
    let endpoints = await provider.getEndpoints();
    expect(endpoints).toEqual(mockEndpoints);
    endpoints = await provider.getEndpoints();
    expect(endpoints).toEqual(mockEndpoints);
  });

  it('Refetches after cache expires', async () => {
    applyMock(mockEndpoints);
    const provider = new S3WebhookConfigurationProvider(logger, bucket, key);
    let endpoints = await provider.getEndpoints();
    expect(endpoints).toEqual(mockEndpoints);

    const updatedEndpoints = [
      {
        name: 'updated',
        endpoint: 'https://updated.com',
        headers: {
          'x-api-key': 'updated',
        },
        hash: '0xupdated',
      },
    ];

    applyMock(updatedEndpoints);

    // still original
    endpoints = await provider.getEndpoints();
    expect(endpoints).toEqual(mockEndpoints);

    // now updates after date changes
    jest.useFakeTimers().setSystemTime(Date.now() + 1000000);
    endpoints = await provider.getEndpoints();
    expect(endpoints).toEqual(updatedEndpoints);
  });

  describe('config change detection', () => {
    const changedEndpoints = [mockEndpoints[0]]; // meta removed

    const expireCache = () => jest.useFakeTimers().setSystemTime(Date.now() + 1000000);

    afterEach(() => {
      jest.useRealTimers();
    });

    it('does not emit on the first fetch after cold start', async () => {
      const putMetricSpy = jest.spyOn(metric, 'putMetric');
      applyMock(mockEndpoints);
      const provider = new S3WebhookConfigurationProvider(logger, bucket, key);
      await provider.getEndpoints();
      expect(putMetricSpy).not.toHaveBeenCalledWith(Metric.RFQ_CONFIG_CHANGED, expect.anything(), expect.anything());
    });

    it('emits RFQ_CONFIG_CHANGED once when a refresh observes a different config', async () => {
      const putMetricSpy = jest.spyOn(metric, 'putMetric');
      applyMock(mockEndpoints);
      const provider = new S3WebhookConfigurationProvider(logger, bucket, key);
      await provider.getEndpoints();

      expireCache();
      applyMock(changedEndpoints);
      await provider.getEndpoints();
      const changeCalls = putMetricSpy.mock.calls.filter((c) => c[0] === Metric.RFQ_CONFIG_CHANGED);
      expect(changeCalls).toHaveLength(1);
    });

    it('does not emit when a refresh returns an identical config', async () => {
      const putMetricSpy = jest.spyOn(metric, 'putMetric');
      applyMock(mockEndpoints);
      const provider = new S3WebhookConfigurationProvider(logger, bucket, key);
      await provider.getEndpoints();

      expireCache();
      applyMock(mockEndpoints);
      await provider.getEndpoints();
      expect(putMetricSpy).not.toHaveBeenCalledWith(Metric.RFQ_CONFIG_CHANGED, expect.anything(), expect.anything());
    });

    it('ignores config order differences', async () => {
      const putMetricSpy = jest.spyOn(metric, 'putMetric');
      applyMock(mockEndpoints);
      const provider = new S3WebhookConfigurationProvider(logger, bucket, key);
      await provider.getEndpoints();

      expireCache();
      applyMock([...mockEndpoints].reverse());
      await provider.getEndpoints();
      expect(putMetricSpy).not.toHaveBeenCalledWith(Metric.RFQ_CONFIG_CHANGED, expect.anything(), expect.anything());
    });

    it('ignores unknown extra fields and key reordering within entries', async () => {
      const putMetricSpy = jest.spyOn(metric, 'putMetric');
      applyMock(mockEndpoints);
      const provider = new S3WebhookConfigurationProvider(logger, bucket, key);
      await provider.getEndpoints();

      expireCache();
      // same fillers, but keys reordered and an unrelated field added by the config repo
      const cosmeticallyDifferent = mockEndpoints.map((e) => {
        const { name, ...rest } = e;
        return { ...rest, name, comment: 'added by config tooling' };
      }) as unknown as WebhookConfiguration[];
      applyMock(cosmeticallyDifferent);
      await provider.getEndpoints();
      expect(putMetricSpy).not.toHaveBeenCalledWith(Metric.RFQ_CONFIG_CHANGED, expect.anything(), expect.anything());
    });

    it('emits when fan-out-affecting fields change (chainIds)', async () => {
      const putMetricSpy = jest.spyOn(metric, 'putMetric');
      applyMock(mockEndpoints);
      const provider = new S3WebhookConfigurationProvider(logger, bucket, key);
      await provider.getEndpoints();

      expireCache();
      applyMock([{ ...mockEndpoints[0], chainIds: [1, 8453] }, mockEndpoints[1]]);
      await provider.getEndpoints();
      const changeCalls = putMetricSpy.mock.calls.filter((c) => c[0] === Metric.RFQ_CONFIG_CHANGED);
      expect(changeCalls).toHaveLength(1);
    });

    it('never throws on malformed config entries — quotes must not 500 over observability', async () => {
      applyMock(mockEndpoints);
      const provider = new S3WebhookConfigurationProvider(logger, bucket, key);
      await provider.getEndpoints();

      expireCache();
      const malformed = [{ name: 'broken' }, ...mockEndpoints] as unknown as WebhookConfiguration[];
      applyMock(malformed);
      await expect(provider.getEndpoints()).resolves.toEqual(malformed);
    });

    it('never throws when the PREVIOUS payload was malformed (null entry) either', async () => {
      // The previous fetch's payload is as unvalidated as the new one: a null entry
      // stored by one refresh must not poison the next refresh's change detection.
      const malformed = [null, ...mockEndpoints] as unknown as WebhookConfiguration[];
      applyMock(malformed);
      const provider = new S3WebhookConfigurationProvider(logger, bucket, key);
      await provider.getEndpoints();

      expireCache();
      applyMock(mockEndpoints);
      await expect(provider.getEndpoints()).resolves.toEqual(mockEndpoints);
    });
  });
});
