import { deriveFanoutStats, FetchOutcome } from '../../../lib/quoters';

const outcome = (overrides: Partial<FetchOutcome>): FetchOutcome => ({
  response: null,
  name: 'filler',
  latencyMs: 0,
  timedOut: false,
  ...overrides,
});

// A truthy stand-in: deriveFanoutStats only checks `response !== null`.
const USABLE = {} as FetchOutcome['response'];

describe('deriveFanoutStats', () => {
  it('charges the gap between the last usable quote and the wall as wasted wait', () => {
    const outcomes = [
      outcome({ name: 'fast-quoter', response: USABLE, latencyMs: 100 }),
      outcome({ name: 'slow-failure', latencyMs: 500, timedOut: true }),
    ];
    expect(deriveFanoutStats(outcomes, 500)).toEqual({ wastedWaitMs: 400, stragglerName: 'slow-failure' });
  });

  it('counts the full wall as wasted when nothing usable came back (all timeouts)', () => {
    const outcomes = [
      outcome({ name: 'a', latencyMs: 500, timedOut: true }),
      outcome({ name: 'b', latencyMs: 480, timedOut: true }),
    ];
    expect(deriveFanoutStats(outcomes, 505)).toEqual({ wastedWaitMs: 505, stragglerName: 'a' });
  });

  it('reports zero waste when the last usable quote set the wall', () => {
    const outcomes = [
      outcome({ name: 'fast-failure', latencyMs: 20 }),
      outcome({ name: 'slow-quoter', response: USABLE, latencyMs: 300 }),
    ];
    expect(deriveFanoutStats(outcomes, 300)).toEqual({ wastedWaitMs: 0, stragglerName: 'slow-quoter' });
  });

  it('clamps to zero when the usable latency measurement lands past the wall measurement', () => {
    const outcomes = [outcome({ name: 'only', response: USABLE, latencyMs: 310 })];
    expect(deriveFanoutStats(outcomes, 305)).toEqual({ wastedWaitMs: 0, stragglerName: 'only' });
  });

  it('handles a single failed outcome', () => {
    const outcomes = [outcome({ name: 'only', latencyMs: 500, timedOut: true })];
    expect(deriveFanoutStats(outcomes, 500)).toEqual({ wastedWaitMs: 500, stragglerName: 'only' });
  });
});
