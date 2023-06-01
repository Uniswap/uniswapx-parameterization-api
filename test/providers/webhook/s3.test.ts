import { S3Client } from '@aws-sdk/client-s3';
import { default as Logger } from 'bunyan';

import { S3WebhookConfigurationProvider, WebhookConfiguration } from '../../../lib/providers';

const mockEndpoints = [
  {
    name: 'google',
    endpoint: 'https://google.com',
    headers: {
      'x-api-key': '1234',
    },
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
    const provider = new S3WebhookConfigurationProvider(bucket, key, logger);
    const endpoints = await provider.getEndpoints();
    expect(endpoints).toEqual(mockEndpoints);
  });

  it('Caches fetched endpoints', async () => {
    applyMock(mockEndpoints);
    const provider = new S3WebhookConfigurationProvider(bucket, key, logger);
    let endpoints = await provider.getEndpoints();
    expect(endpoints).toEqual(mockEndpoints);
    endpoints = await provider.getEndpoints();
    expect(endpoints).toEqual(mockEndpoints);
  });

  it('Refetches after cache expires', async () => {
    applyMock(mockEndpoints);
    const provider = new S3WebhookConfigurationProvider(bucket, key, logger);
    let endpoints = await provider.getEndpoints();
    expect(endpoints).toEqual(mockEndpoints);

    const updatedEndpoints = [
      {
        endpoint: 'https://updated.com',
        headers: {
          'x-api-key': 'updated',
        },
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
});
