import { default as Logger } from 'bunyan';

import { FillerComplianceConfiguration } from '../../../lib/providers/compliance';
import {
  COMPLIANCE_REFRESH_INTERVAL_MS,
  ComplianceS3Client,
  S3FillerComplianceConfigurationProvider,
} from '../../../lib/providers/compliance/s3';

type SendResult = Awaited<ReturnType<ComplianceS3Client['send']>>;

// Each send() runs the next queued outcome; an unqueued send() throws instead of hanging.
class FakeS3Client implements ComplianceS3Client {
  public sendCount = 0;
  constructor(private readonly outcomes: (() => Promise<SendResult>)[]) {}

  send(): Promise<SendResult> {
    const next = this.outcomes[this.sendCount++];
    if (!next) throw new Error(`unexpected S3 fetch #${this.sendCount}`);
    return next();
  }
}

const ok = (configs: FillerComplianceConfiguration[]) => () =>
  Promise.resolve({ Body: { transformToString: () => Promise.resolve(JSON.stringify(configs)) } });
const fail = () => Promise.reject(new Error('TimeoutError'));
// Drains pending microtasks so a background refresh can land.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const ENDPOINT = 'https://filler.example/rfq';
const SWAPPER = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const OTHER = '0x0000000000000000000000000000000000000001';
const configs = [{ endpoints: [ENDPOINT], addresses: [SWAPPER] }];

const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

describe('S3FillerComplianceConfigurationProvider', () => {
  const START = 1_700_000_000_000;
  let now: number;

  beforeEach(() => {
    now = START;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  const makeProvider = (s3: FakeS3Client) =>
    new S3FillerComplianceConfigurationProvider(logger, 'test-bucket', 'test-key', s3);

  it('treats an empty config as loaded and does not refetch it per request', async () => {
    const s3 = new FakeS3Client([ok([])]);
    const provider = makeProvider(s3);
    for (let i = 0; i < 5; i++) {
      await provider.ensureLoaded();
      expect(provider.isExcluded(ENDPOINT, SWAPPER)).toBe(false);
    }
    expect(s3.sendCount).toBe(1);
  });

  it('matches swapper addresses case-insensitively and ignores unknown endpoints', async () => {
    const provider = makeProvider(new FakeS3Client([ok(configs)]));
    await provider.ensureLoaded();
    expect(provider.isExcluded(ENDPOINT, SWAPPER.toLowerCase())).toBe(true);
    expect(provider.isExcluded(ENDPOINT, SWAPPER.toUpperCase())).toBe(true);
    expect(provider.isExcluded(ENDPOINT, OTHER)).toBe(false);
    expect(provider.isExcluded('https://unknown.example', SWAPPER)).toBe(false);
  });

  it('refreshes in the background once the interval elapses, then swaps the new data in', async () => {
    let finishRefresh!: (result: SendResult) => void;
    const pending = new Promise<SendResult>((resolve) => (finishRefresh = resolve));
    const s3 = new FakeS3Client([ok(configs), () => pending]);
    const provider = makeProvider(s3);
    await provider.ensureLoaded();

    now = START + COMPLIANCE_REFRESH_INTERVAL_MS - 1;
    await provider.ensureLoaded();
    expect(s3.sendCount).toBe(1);

    now = START + COMPLIANCE_REFRESH_INTERVAL_MS;
    // Resolves while the fetch is still pending, still serving the old data.
    await provider.ensureLoaded();
    expect(provider.isExcluded(ENDPOINT, SWAPPER)).toBe(true);
    // Concurrent callers share the single in-flight fetch.
    await provider.ensureLoaded();
    expect(s3.sendCount).toBe(2);

    finishRefresh(await ok([{ endpoints: [ENDPOINT], addresses: [OTHER] }])());
    await flush();
    expect(provider.isExcluded(ENDPOINT, SWAPPER)).toBe(false);
    expect(provider.isExcluded(ENDPOINT, OTHER)).toBe(true);
  });

  it('keeps the last good data when a refresh fails and retries only at the next interval', async () => {
    const s3 = new FakeS3Client([ok(configs), fail, ok([])]);
    const provider = makeProvider(s3);
    await provider.ensureLoaded();

    now = START + COMPLIANCE_REFRESH_INTERVAL_MS;
    await provider.ensureLoaded();
    await flush();
    await provider.ensureLoaded();
    expect(s3.sendCount).toBe(2);
    expect(provider.isExcluded(ENDPOINT, SWAPPER)).toBe(true);

    now = START + 2 * COMPLIANCE_REFRESH_INTERVAL_MS;
    await provider.ensureLoaded();
    await flush();
    expect(s3.sendCount).toBe(3);
    expect(provider.isExcluded(ENDPOINT, SWAPPER)).toBe(false);
  });

  it('fails open on a failed first load and retries only at the next interval', async () => {
    const s3 = new FakeS3Client([fail, ok(configs)]);
    const provider = makeProvider(s3);
    await provider.ensureLoaded();
    await provider.ensureLoaded();
    expect(s3.sendCount).toBe(1);
    expect(provider.isExcluded(ENDPOINT, SWAPPER)).toBe(false);

    now = START + COMPLIANCE_REFRESH_INTERVAL_MS;
    await provider.ensureLoaded();
    await flush();
    expect(provider.isExcluded(ENDPOINT, SWAPPER)).toBe(true);
  });
});
