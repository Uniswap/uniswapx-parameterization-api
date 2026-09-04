import { S3Client } from '@aws-sdk/client-s3';

import {
  CONFIG_S3_CONNECTION_TIMEOUT_MS,
  CONFIG_S3_MAX_ATTEMPTS,
  CONFIG_S3_REQUEST_TIMEOUT_MS,
  createConfigS3Client,
} from '../../lib/util/config-s3-client';

jest.mock('@aws-sdk/client-s3');

describe('createConfigS3Client', () => {
  it('bounds connection, request, and retry budget so a stalled fetch cannot hold the quote path', () => {
    createConfigS3Client();
    expect(S3Client).toHaveBeenCalledWith({
      requestHandler: {
        connectionTimeout: CONFIG_S3_CONNECTION_TIMEOUT_MS,
        requestTimeout: CONFIG_S3_REQUEST_TIMEOUT_MS,
      },
      maxAttempts: CONFIG_S3_MAX_ATTEMPTS,
    });
  });

  it('keeps the total worst-case stall on the order of seconds, not the kernel SYN ladder', () => {
    // 2 attempts × 2s request timeout + retry backoff (~hundreds of ms) ≈ 4s ≪ 15s
    expect(CONFIG_S3_MAX_ATTEMPTS * CONFIG_S3_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(5000);
    expect(CONFIG_S3_CONNECTION_TIMEOUT_MS).toBeLessThanOrEqual(CONFIG_S3_REQUEST_TIMEOUT_MS);
  });
});
