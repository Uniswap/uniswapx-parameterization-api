import bunyan from 'bunyan';

import { FillerTimestamps } from '../../../lib/cron/fade-rate-v2';
import { DynamoCircuitBreakerConfigurationProvider } from '../../../lib/providers/circuit-breaker/dynamo';
import { BaseTimestampRepository, FillerTimestampMap, TimestampRepoRow } from '../../../lib/repositories';

const log = bunyan.createLogger({ name: 'cb-provider.test', level: bunyan.FATAL + 1 });

// Serves rows from an in-memory map and records every endpoint list it was asked for.
class FakeTimestampRepository implements BaseTimestampRepository {
  public requests: string[][] = [];
  public failNext = false;

  constructor(public rows: FillerTimestampMap) {}

  async getFillerTimestampsMap(hashes: string[]): Promise<FillerTimestampMap> {
    this.requests.push(hashes);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('dynamo unavailable');
    }
    return new Map([...this.rows].filter(([hash]) => hashes.includes(hash)));
  }

  async getTimestampsBatch(): Promise<TimestampRepoRow[]> {
    throw new Error('not used by the breaker');
  }

  async getFillerTimestamps(): Promise<TimestampRepoRow> {
    throw new Error('not used by the breaker');
  }

  async updateTimestampsBatch(): Promise<void> {
    throw new Error('not used by the breaker');
  }
}

const now = Math.floor(Date.now() / 1000);
const FILLER_TIMESTAMPS: FillerTimestamps = new Map([
  [
    'filler1',
    {
      lastExaminedTimestamp: now - 150,
      blockUntilTimestamp: NaN,
      fadeWindowStart: NaN,
      consecutiveBlocks: NaN,
      consecutiveCleanRuns: 0,
    },
  ],
  [
    'filler2',
    {
      lastExaminedTimestamp: now - 75,
      blockUntilTimestamp: now - 50,
      fadeWindowStart: now - 50,
      consecutiveBlocks: 0,
      consecutiveCleanRuns: 0,
    },
  ],
  [
    'filler3',
    {
      lastExaminedTimestamp: now - 101,
      blockUntilTimestamp: now + 1000,
      fadeWindowStart: now + 1000,
      consecutiveBlocks: 0,
      consecutiveCleanRuns: 0,
    },
  ],
  [
    'filler4',
    {
      lastExaminedTimestamp: now - 150,
      blockUntilTimestamp: NaN,
      fadeWindowStart: NaN,
      consecutiveBlocks: 0,
      consecutiveCleanRuns: 0,
    },
  ],
  [
    'filler5',
    {
      lastExaminedTimestamp: now - 150,
      blockUntilTimestamp: now + 100,
      fadeWindowStart: now + 100,
      consecutiveBlocks: 1,
      consecutiveCleanRuns: 0,
    },
  ],
]);

const WEBHOOK_CONFIGS = [
  {
    name: 'f1',
    endpoint: 'filler1',
    hash: '0xfiller1',
  },
  {
    name: 'f2',
    endpoint: 'filler2',
    hash: '0xfiller2',
  },
  {
    name: 'f3',
    endpoint: 'filler3',
    hash: '0xfiller3',
  },
  {
    name: 'f4',
    endpoint: 'filler4',
    hash: '0xfiller4',
  },
  {
    name: 'f5',
    endpoint: 'filler5',
    hash: '0xfiller5',
  },
];

describe('DynamoCircuitBreakerConfigurationProvider', () => {
  let repo: FakeTimestampRepository;
  let provider: DynamoCircuitBreakerConfigurationProvider;

  beforeEach(() => {
    repo = new FakeTimestampRepository(FILLER_TIMESTAMPS);
    provider = new DynamoCircuitBreakerConfigurationProvider(log, repo);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns eligible endpoints', async () => {
    expect(await provider.getEndpointStatuses(WEBHOOK_CONFIGS)).toEqual({
      enabled: [
        {
          name: 'f1',
          endpoint: 'filler1',
          hash: '0xfiller1',
        },
        {
          name: 'f2',
          endpoint: 'filler2',
          hash: '0xfiller2',
        },
        {
          name: 'f4',
          endpoint: 'filler4',
          hash: '0xfiller4',
        },
      ],
      disabled: [
        {
          webhook: {
            name: 'f3',
            endpoint: 'filler3',
            hash: '0xfiller3',
          },
          blockUntil: now + 1000,
        },
        {
          webhook: {
            name: 'f5',
            endpoint: 'filler5',
            hash: '0xfiller5',
          },
          blockUntil: now + 100,
        },
      ],
    });
  });

  it('reads bench state on the first request of a fresh container', async () => {
    const statuses = await provider.getEndpointStatuses(WEBHOOK_CONFIGS);

    expect(repo.requests).toHaveLength(1);
    expect(statuses.disabled.map((d) => d.webhook.endpoint)).toEqual(['filler3', 'filler5']);
  });

  it('reads bench state for a filler added to the config after the first request', async () => {
    const [f1, f2, f3] = WEBHOOK_CONFIGS;
    await provider.getEndpointStatuses([f1, f2]);

    // filler3 is benched; it joins the config well inside the 30s refresh window.
    const statuses = await provider.getEndpointStatuses([f1, f2, f3]);

    expect(repo.requests).toEqual([
      ['filler1', 'filler2'],
      ['filler1', 'filler2', 'filler3'],
    ]);
    expect(statuses.disabled.map((d) => d.webhook.endpoint)).toEqual(['filler3']);
  });

  it('reuses the cached timestamps for the same endpoint set, in any order or with duplicates', async () => {
    const [f1, f2, f3] = WEBHOOK_CONFIGS;
    await provider.getEndpointStatuses([f1, f2, f3]);
    await provider.getEndpointStatuses([f3, f1, f2, f1]);

    expect(repo.requests).toEqual([['filler1', 'filler2', 'filler3']]);
  });

  it('refetches the same endpoint set once the refresh window has passed', async () => {
    const start = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
    await provider.getEndpointStatuses(WEBHOOK_CONFIGS);

    nowSpy.mockReturnValue(start + 30_001);
    await provider.getEndpointStatuses(WEBHOOK_CONFIGS);

    expect(repo.requests).toHaveLength(2);
  });

  it('keeps benched fillers benched when a later read fails, and retries on the next request', async () => {
    const start = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
    await provider.getEndpointStatuses(WEBHOOK_CONFIGS);

    nowSpy.mockReturnValue(start + 30_001);
    repo.failNext = true;
    const duringBlip = await provider.getEndpointStatuses(WEBHOOK_CONFIGS);
    expect(duringBlip.disabled.map((d) => d.webhook.endpoint)).toEqual(['filler3', 'filler5']);

    await provider.getEndpointStatuses(WEBHOOK_CONFIGS);
    expect(repo.requests).toHaveLength(3);
  });

  it('fails open when the first read fails, and retries on the next request', async () => {
    repo.failNext = true;
    const failed = await provider.getEndpointStatuses(WEBHOOK_CONFIGS);
    expect(failed).toEqual({ enabled: WEBHOOK_CONFIGS, disabled: [] });

    const recovered = await provider.getEndpointStatuses(WEBHOOK_CONFIGS);
    expect(repo.requests).toHaveLength(2);
    expect(recovered.disabled.map((d) => d.webhook.endpoint)).toEqual(['filler3', 'filler5']);
  });

  it('does not read the table when there are no endpoints', async () => {
    expect(await provider.getEndpointStatuses([])).toEqual({ enabled: [], disabled: [] });
    expect(repo.requests).toHaveLength(0);
  });
});
