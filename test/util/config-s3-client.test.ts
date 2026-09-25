import {
  CONFIG_S3_CONNECTION_TIMEOUT_MS,
  CONFIG_S3_MAX_ATTEMPTS,
  CONFIG_S3_REQUEST_TIMEOUT_MS,
  createConfigS3Client,
} from '../../lib/util/config-s3-client';

// The SDK resolves request-handler options into a private promise; reading it back from a real
// client proves the bounds actually reach the handler (a misspelled option is silently ignored).
type ResolvedHandlerOptions = { connectionTimeout?: number; requestTimeout?: number };

describe('createConfigS3Client', () => {
  it('bounds connection, request, and retry budget so a stalled fetch cannot hold the quote path', async () => {
    const client = createConfigS3Client();
    const handler = client.config.requestHandler as unknown as { configProvider: Promise<ResolvedHandlerOptions> };
    const options = await handler.configProvider;

    expect(options.connectionTimeout).toBe(CONFIG_S3_CONNECTION_TIMEOUT_MS);
    expect(options.requestTimeout).toBe(CONFIG_S3_REQUEST_TIMEOUT_MS);
    expect(await client.config.maxAttempts()).toBe(CONFIG_S3_MAX_ATTEMPTS);
  });

  it('keeps the total worst-case stall on the order of seconds, not the kernel SYN ladder', () => {
    // 2 attempts × 2s request timeout + retry backoff (~hundreds of ms) ≈ 4s ≪ 15s
    expect(CONFIG_S3_MAX_ATTEMPTS * CONFIG_S3_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(5000);
    expect(CONFIG_S3_CONNECTION_TIMEOUT_MS).toBeLessThanOrEqual(CONFIG_S3_REQUEST_TIMEOUT_MS);
  });
});
