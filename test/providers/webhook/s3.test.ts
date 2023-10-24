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
    addresses: ['google.com'],
    hash: '0xgoogle'
  },
  {
    name: 'meta',
    endpoint: 'https://meta.com',
    addresses: ['facebook.com', 'meta.com'],
    hash: '0xmeta'
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

  it('Generates filler endpoint to filler map', async () => {
    applyMock(mockEndpoints);
    const provider = new S3WebhookConfigurationProvider(logger, bucket, key);
    const map = await provider.addressToFillerHash();
    expect(map.get('google.com')).toEqual('0xgoogle');
    expect(map.get('facebook.com')).toEqual('0xmeta');
    expect(map.get('meta.com')).toEqual('0xmeta');
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
});
