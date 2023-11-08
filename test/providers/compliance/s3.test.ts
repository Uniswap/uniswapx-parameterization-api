import { S3Client } from '@aws-sdk/client-s3';
import { default as Logger } from 'bunyan';

import { FillerComplianceConfiguration,S3FillerComplianceConfigurationProvider } from '../../../lib/providers/compliance';

const mockConfigs = [
  {
    endpoints: ['https://google.com'],
    addresses: ['0x1234'],
  },
  {
    endpoints: ['https://meta.com'],
    addresses: ['0x1234', '0x5678'],
  },
];


function applyMock(configs: FillerComplianceConfiguration[]) {
  jest.spyOn(S3Client.prototype, 'send').mockImplementationOnce(() =>
    Promise.resolve({
      Body: {
        transformToString: () => Promise.resolve(JSON.stringify(configs)),
      },
    })
  );
}


// silent logger in tests
const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

describe('S3ComplianceConfigurationProvider', () => {
  const bucket = 'test-bucket';
  const key = 'test-key';
  
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('fetches configs', async () => {
    applyMock(mockConfigs);
    const provider = new S3FillerComplianceConfigurationProvider(logger, bucket, key);
    const endpoints = await provider.getConfigs();
    expect(endpoints).toEqual(mockConfigs);
  });
  
  it('generates addr to endpoints map', async () => {
    applyMock(mockConfigs);
    const provider = new S3FillerComplianceConfigurationProvider(logger, bucket, key);
    expect(await provider.getAddrToEndpointsMap()).toMatchObject(
      new Map([
        ['0x1234', new Set(['https://google.com', 'https://meta.com'])],
        ['0x5678', new Set(['https://meta.com'])],
      ])
    )
  });
});