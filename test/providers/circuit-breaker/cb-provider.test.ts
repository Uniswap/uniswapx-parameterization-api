import { FillerTimestamps } from '../../../lib/cron/fade-rate-v2';
import { MockV2CircuitBreakerConfigurationProvider } from '../../../lib/providers/circuit-breaker/mock';

const FILLERS = ['filler1', 'filler2', 'filler3', 'filler4', 'filler5'];
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

describe('V2CircuitBreakerProvider', () => {
  const provider = new MockV2CircuitBreakerConfigurationProvider(FILLERS, FILLER_TIMESTAMPS);

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
});
