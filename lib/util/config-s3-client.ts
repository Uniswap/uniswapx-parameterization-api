import { S3Client } from '@aws-sdk/client-s3';

// The webhook and compliance config providers refresh their S3 JSON inline on the
// quote path (~every 5 minutes per instance). The SDK ships with no client-side
// timeout, so a stalled connection held every quote on that instance until the
// kernel gave up (~15s SYN-retransmit ladder — the 2026-07 quote-stall incident).
// These bounds cap the stall; callers keep serving their last cached config when a
// refresh fails.
export const CONFIG_S3_CONNECTION_TIMEOUT_MS = 1000;
export const CONFIG_S3_REQUEST_TIMEOUT_MS = 2000;
// The standard retry strategy defaults to 3 attempts, which would triple the
// worst-case stall. Two attempts bounds it at roughly 2 × requestTimeout.
export const CONFIG_S3_MAX_ATTEMPTS = 2;

export function createConfigS3Client(): S3Client {
  return new S3Client({
    requestHandler: {
      connectionTimeout: CONFIG_S3_CONNECTION_TIMEOUT_MS,
      requestTimeout: CONFIG_S3_REQUEST_TIMEOUT_MS,
    },
    maxAttempts: CONFIG_S3_MAX_ATTEMPTS,
  });
}
