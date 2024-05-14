import { FillerTimestamps } from '../../../lib/cron/fade-rate-v2';
import { MockV2CircuitBreakerConfigurationProvider } from '../../../lib/providers/circuit-breaker/mock';

const FILLERS = ['filler1', 'filler2', 'filler3', 'filler4', 'filler5'];
const now = Math.floor(Date.now() / 1000);
const FILLER_TIMESTAMPS: FillerTimestamps = new Map([
  ['filler1', { lastPostTimestamp: now - 150, blockUntilTimestamp: NaN }],
  ['filler2', { lastPostTimestamp: now - 75, blockUntilTimestamp: now - 50 }],
  ['filler3', { lastPostTimestamp: now - 101, blockUntilTimestamp: now + 1000 }],
  ['filler4', { lastPostTimestamp: now - 150, blockUntilTimestamp: NaN }],
  ['filler5', { lastPostTimestamp: now - 150, blockUntilTimestamp: now + 100 }],
]);

const WEBHOOK_CONFIGS = [
  {
    name: 'f1',
    endpoint: 'http://localhost:3000',
    hash: 'filler1',
  },
  {
    name: 'f2',
    endpoint: 'http://localhost:3000',
    hash: 'filler2',
  },
  {
    name: 'f3',
    endpoint: 'http://localhost:3000',
    hash: 'filler3',
  },
  {
    name: 'f4',
    endpoint: 'http://localhost:3000',
    hash: 'filler4',
  },
  {
    name: 'f5',
    endpoint: 'http://localhost:3000',
    hash: 'filler5',
  },
];

describe('V2CircuitBreakerProvider', () => {
  const provider = new MockV2CircuitBreakerConfigurationProvider(FILLERS, FILLER_TIMESTAMPS);

  it('returns eligible endpoints', async () => {
    expect(await provider.getEligibleEndpoints(WEBHOOK_CONFIGS)).toEqual([
      {
        name: 'f1',
        endpoint: 'http://localhost:3000',
        hash: 'filler1',
      },
      {
        name: 'f2',
        endpoint: 'http://localhost:3000',
        hash: 'filler2',
      },
      {
        name: 'f4',
        endpoint: 'http://localhost:3000',
        hash: 'filler4',
      },
    ]);
  });
});
