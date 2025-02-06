import { S3Client } from '@aws-sdk/client-s3';
import axios from 'axios';
import { default as Logger } from 'bunyan';

import {
  FillerComplianceConfiguration,
  S3FillerComplianceConfigurationProvider,
} from '../../../lib/providers/compliance';

const mockConfigs = [
  {
    endpoints: ['https://google.com'],
    addresses: ['0x1234'],
  },
  {
    endpoints: ['https://meta.com'],
    addresses: ['0x1234', '0x5678'],
  },
  {
    endpoints: ['https://x.com'],
    addresses: ['0x7890'],
    complianceListUrl: 'https://example.com/compliance-list.json',
  },
];

const mockComplianceList = {
  addresses: ['0x2345', '0x6789'],
};

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

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

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

  it('generates endpoint to addrs map', async () => {
    applyMock(mockConfigs);
    const provider = new S3FillerComplianceConfigurationProvider(logger, bucket, key);
    const map = await provider.getEndpointToExcludedAddrsMap();
    expect(map).toMatchObject(
      new Map([
        ['https://google.com', new Set(['0x1234'])],
        ['https://meta.com', new Set(['0x1234', '0x5678'])],
        ['https://x.com', new Set(['0x7890'])],
      ])
    );
  });

  it('fetches and merges compliance list addresses', async () => {
    applyMock(mockConfigs);
    mockedAxios.get.mockResolvedValueOnce({ 
      status: 200, 
      data: mockComplianceList 
    });

    const provider = new S3FillerComplianceConfigurationProvider(logger, bucket, key);
    const map = await provider.getEndpointToExcludedAddrsMap();
    
    expect(mockedAxios.get).toHaveBeenCalledWith('https://example.com/compliance-list.json');
    expect(map).toMatchObject(
      new Map([
        ['https://google.com', new Set(['0x1234'])],
        ['https://meta.com', new Set(['0x1234', '0x5678'])],
        ['https://x.com', new Set(['0x7890', '0x2345', '0x6789'])],
      ])
    );
  });

  it('handles compliance list fetch failure gracefully', async () => {
    applyMock(mockConfigs);
    mockedAxios.get.mockRejectedValueOnce(new Error('Network error'));

    const provider = new S3FillerComplianceConfigurationProvider(logger, bucket, key);
    const map = await provider.getEndpointToExcludedAddrsMap();
    
    expect(mockedAxios.get).toHaveBeenCalledWith('https://example.com/compliance-list.json');
    expect(map).toMatchObject(
      new Map([
        ['https://google.com', new Set(['0x1234'])],
        ['https://meta.com', new Set(['0x1234', '0x5678'])],
        ['https://x.com', new Set(['0x7890'])],
      ])
    );
  });
});
