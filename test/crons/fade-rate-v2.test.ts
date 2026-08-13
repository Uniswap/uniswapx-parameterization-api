import Logger from 'bunyan';

import {
  BASE_BLOCK_SECS,
  calculateBlockUntilTimestamp,
  calculateNewTimestamps,
  CHRONIC_RATE_EMISSION_FLOOR,
  CHRONIC_RATE_MIN_SAMPLE,
  CLEAN_RUNS_PER_DECAY,
  countActiveBlocks,
  FADE_RATE_BLOCK_THRESHOLD,
  FillerFadeStats,
  FillerFadeStatsMap,
  FillerTimestamps,
  getFillersFadeStats,
  laplaceSmoothedFadeRate,
  LAPLACE_ALPHA,
  LAPLACE_BETA,
  MAX_BLOCK_BACKOFF_EXPONENT,
  MAX_FADED_ORDER_HASHES,
  STREAK_FINALITY_LAG_SECS,
  UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
} from '../../lib/cron/fade-rate-v2';
import { Metric, metricContext } from '../../lib/entities';
import {
  ORDERS_PER_FILLER_LIMIT,
  TimestampRepoRow,
  ToUpdateTimestampRow,
  V2FadesRowType,
} from '../../lib/repositories';

const now = Math.floor(Date.now() / 1000);
// deadlines at least this old are past the streak's finality horizon (load state final)
const FINAL = STREAK_FINALITY_LAG_SECS + 100;

// silent logger in tests
const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

// helper to build a faded/non-faded order row
const order = (fillerAddress: string, faded: 0 | 1, deadline: number, orderHash?: string): V2FadesRowType => ({
  fillerAddress,
  faded,
  postTimestamp: deadline - 20,
  deadline,
  orderHash: orderHash ?? `0xorder${fillerAddress.slice(-2)}at${deadline}`,
});

// factories so tests spell out only the fields they exercise; defaults are a quiet,
// under-threshold filler with no stored circuit-breaker history
const fadeStats = (overrides: Partial<FillerFadeStats> = {}): FillerFadeStats => ({
  fadeRate: 0.05,
  duringBlockRate: 0.05,
  newCompletions: 1,
  newFades: 0,
  chronicRate: 0,
  chronicTotal: 0,
  saturatedAddresses: 0,
  ...overrides,
});
const cbState = (overrides: Partial<Omit<TimestampRepoRow, 'hash'>> = {}): Omit<TimestampRepoRow, 'hash'> => ({
  lastExaminedTimestamp: now - 100,
  blockUntilTimestamp: 0,
  fadeWindowStart: now - 50,
  consecutiveBlocks: 0,
  consecutiveCleanRuns: 0,
  ...overrides,
});

describe('FadeRateV2 cron', () => {
  describe('laplaceSmoothedFadeRate', () => {
    it('returns the prior mean for an empty sample', () => {
      // (0 + 1) / (0 + 1 + 19) = 1/20 = 0.05
      expect(laplaceSmoothedFadeRate(0, 0)).toBeCloseTo(LAPLACE_ALPHA / (LAPLACE_ALPHA + LAPLACE_BETA), 6);
      expect(laplaceSmoothedFadeRate(0, 0)).toBeCloseTo(0.05, 4);
    });

    it('pulls small samples toward the prior', () => {
      // raw 50% (1/2) -> (1+1)/(2+20) ≈ 0.091, well under the 12% threshold
      expect(laplaceSmoothedFadeRate(1, 2)).toBeCloseTo(2 / 22, 6);
      expect(laplaceSmoothedFadeRate(1, 2)).toBeLessThan(FADE_RATE_BLOCK_THRESHOLD);
    });

    it('converges to the empirical rate with volume', () => {
      // sustained 50% on 50 samples -> clearly over threshold
      expect(laplaceSmoothedFadeRate(25, 50)).toBeCloseTo(26 / 70, 6);
      expect(laplaceSmoothedFadeRate(25, 50)).toBeGreaterThan(FADE_RATE_BLOCK_THRESHOLD);
      // high volume, low rate stays safe
      expect(laplaceSmoothedFadeRate(3, 500)).toBeLessThan(FADE_RATE_BLOCK_THRESHOLD);
    });

    it('catches the evasion scenarios under the 24h / latest-100 window', () => {
      // These pin the window parameters (24h view window, ORDERS_PER_FILLER_LIMIT=100)
      // to the scenarios they were chosen for — see PR #454 review discussion.

      // Low-volume filler fading every order (e.g. 1 order/hr): the 24h window
      // accumulates their orders, so 2 fades already trips the threshold.
      expect(laplaceSmoothedFadeRate(2, 2)).toBeCloseTo(3 / 22, 6);
      expect(laplaceSmoothedFadeRate(2, 2)).toBeGreaterThan(FADE_RATE_BLOCK_THRESHOLD);

      // High-volume chronic ~14% fader (e.g. 7 fades per 50 orders/hr): the latest-100
      // cap holds ~14 fades -> 15/120 = 12.5% > 12%. (With the old 1h/latest-50 window
      // this filler sat at 8/70 = 11.4% and was never blocked.)
      expect(laplaceSmoothedFadeRate(14, 100)).toBeCloseTo(15 / 120, 6);
      expect(laplaceSmoothedFadeRate(14, 100)).toBeGreaterThan(FADE_RATE_BLOCK_THRESHOLD);

      // A legitimate sustained ~10% filler at the same volume stays clear.
      expect(laplaceSmoothedFadeRate(10, 100)).toBeLessThan(FADE_RATE_BLOCK_THRESHOLD);
    });
  });

  describe('getFillersFadeStats', () => {
    const ADDRESS_TO_FILLER = new Map<string, string>([
      ['0x0000000000000000000000000000000000000001', 'fillerA'],
      ['0x0000000000000000000000000000000000000002', 'fillerB'],
      ['0x0000000000000000000000000000000000000003', 'fillerC'],
      ['0x0000000000000000000000000000000000000004', 'fillerC'],
    ]);

    it('computes the smoothed rates for a filler with no prior timestamp', () => {
      const rows: V2FadesRowType[] = [
        ...Array(3)
          .fill(0)
          .map(() => order('0x0000000000000000000000000000000000000001', 1, now - FINAL)),
        ...Array(7)
          .fill(0)
          .map(() => order('0x0000000000000000000000000000000000000001', 0, now - FINAL)),
      ];
      const stats = getFillersFadeStats(rows, ADDRESS_TO_FILLER, new Map(), now, logger);
      // window = all 10 orders (no prior block), rate = (3+1)/(10+20) = 4/30
      expect(stats['fillerA'].fadeRate).toBeCloseTo(4 / 30, 6);
      // never blocked => empty during-block cohort => prior mean
      expect(stats['fillerA'].duringBlockRate).toBeCloseTo(0.05, 6);
      // no prior timestamp => every final completion is new
      expect(stats['fillerA'].newCompletions).toEqual(10);
      expect(stats['fillerA'].newFades).toEqual(3);
      // chronic view: raw rate over all rows, no smoothing
      expect(stats['fillerA'].chronicRate).toBeCloseTo(3 / 10, 6);
      expect(stats['fillerA'].chronicTotal).toEqual(10);
    });

    it('defers streak classification until rows are final (batch load lag)', () => {
      // A fade fresher than STREAK_FINALITY_LAG_SECS scores in the rate window immediately,
      // but is not classified for the streak yet: its load state may still change (a fill row
      // that lands next batch would flip it to faded=0), so counting it now could reset an
      // honest filler's streak on a transient. It is classified once it ages past the horizon.
      const fresh = order('0x0000000000000000000000000000000000000001', 1, now - 100);
      const stats = getFillersFadeStats([fresh], ADDRESS_TO_FILLER, new Map(), now, logger);
      expect(stats['fillerA'].fadeRate).toBeCloseTo(2 / 21, 6); // scored for blocking
      expect(stats['fillerA'].newCompletions).toEqual(0); // not yet streak-classified
      expect(stats['fillerA'].newFades).toEqual(0);
      // the chronic watchlist view also scores only final rows (a not-yet-loaded fill would
      // read as a transient fade and sawtooth the metric every load cycle)
      expect(stats['fillerA'].chronicTotal).toEqual(0);

      // next run after the row ages past the horizon: classified exactly once
      const later = now + STREAK_FINALITY_LAG_SECS;
      const timestamps: FillerTimestamps = new Map([
        ['fillerA', cbState({ lastExaminedTimestamp: now, fadeWindowStart: 0 })],
      ]);
      const statsLater = getFillersFadeStats([fresh], ADDRESS_TO_FILLER, timestamps, later, logger);
      expect(statsLater['fillerA'].newCompletions).toEqual(1);
      expect(statsLater['fillerA'].newFades).toEqual(1);
    });

    it('excludes pre-block orders from the rate window', () => {
      const fillerTimestamps: FillerTimestamps = new Map([
        // fadeWindowStart (the clean-slate floor) is the last block end at now-20000
        [
          'fillerB',
          cbState({ lastExaminedTimestamp: now - 15000, fadeWindowStart: now - 20000, consecutiveBlocks: 1 }),
        ],
      ]);
      const rows: V2FadesRowType[] = [
        // pre-block fades (deadline now-30000, before block end now-20000): excluded from
        // window; also before lastExaminedTimestamp (now-15000) so already streak-classified
        // by an earlier run and not part of the during-block cohort
        order('0x0000000000000000000000000000000000000002', 1, now - 30000),
        order('0x0000000000000000000000000000000000000002', 1, now - 30000),
        // post-block orders (deadline now-10000, past the finality horizon): 1 faded + 4 clean
        order('0x0000000000000000000000000000000000000002', 1, now - 10000),
        ...Array(4)
          .fill(0)
          .map(() => order('0x0000000000000000000000000000000000000002', 0, now - 10000)),
      ];
      const stats = getFillersFadeStats(rows, ADDRESS_TO_FILLER, fillerTimestamps, now, logger);
      // window = 5 post-block orders, 1 faded => (1+1)/(5+20) = 2/25
      expect(stats['fillerB'].fadeRate).toBeCloseTo(2 / 25, 6);
      // stale pre-block fades don't resurrect as a during-block cohort
      expect(stats['fillerB'].duringBlockRate).toBeCloseTo(0.05, 6);
      // only the 5 final post-block orders are newly streak-classified, 1 of them faded
      expect(stats['fillerB'].newCompletions).toEqual(5);
      expect(stats['fillerB'].newFades).toEqual(1);
      // chronic view has NO amnesty: the pre-block fades excluded from the rate window still
      // count here (3 fades over all 7 rows)
      expect(stats['fillerB'].chronicRate).toBeCloseTo(3 / 7, 6);
      expect(stats['fillerB'].chronicTotal).toEqual(7);
    });

    it('scores in-flight orders that completed during a block, even after it expired', () => {
      // Block ran until now-10000 and has expired; the last cron run was at now-40000 (while
      // blocked). Orders completed in between were in flight during the block: below the
      // clean-slate floor, so they never enter the post-block window — the during-block
      // cohort is the only path that scores them.
      const fillerTimestamps: FillerTimestamps = new Map([
        [
          'fillerB',
          cbState({ lastExaminedTimestamp: now - 40000, fadeWindowStart: now - 10000, consecutiveBlocks: 1 }),
        ],
      ]);
      const rows: V2FadesRowType[] = [
        // during-block cohort: 2 faded + 1 clean
        order('0x0000000000000000000000000000000000000002', 1, now - 20000),
        order('0x0000000000000000000000000000000000000002', 1, now - 20000),
        order('0x0000000000000000000000000000000000000002', 0, now - 20000),
        // post-block window: 1 clean (past the finality horizon)
        order('0x0000000000000000000000000000000000000002', 0, now - FINAL),
      ];
      const stats = getFillersFadeStats(rows, ADDRESS_TO_FILLER, fillerTimestamps, now, logger);
      // cohort = (2+1)/(3+20) = 3/23 ≈ 13.0% > threshold => calculateNewTimestamps re-blocks
      expect(stats['fillerB'].duringBlockRate).toBeCloseTo(3 / 23, 6);
      expect(stats['fillerB'].duringBlockRate).toBeGreaterThan(FADE_RATE_BLOCK_THRESHOLD);
      // window = 1 clean post-block order
      expect(stats['fillerB'].fadeRate).toBeCloseTo(1 / 21, 6);
      // only the post-floor clean fill earns streak credit: fills served while benched are
      // not recovery, so the 3 during-block completions don't count...
      expect(stats['fillerB'].newCompletions).toEqual(1);
      // ...but during-block FADES still count against the streak (a fade is a fade)
      expect(stats['fillerB'].newFades).toEqual(2);
    });

    it('aggregates multiple addresses belonging to the same filler', () => {
      const rows: V2FadesRowType[] = [
        order('0x0000000000000000000000000000000000000003', 1, now - FINAL),
        order('0x0000000000000000000000000000000000000004', 1, now - FINAL),
        order('0x0000000000000000000000000000000000000004', 0, now - FINAL),
        order('0x0000000000000000000000000000000000000004', 0, now - FINAL),
      ];
      const stats = getFillersFadeStats(rows, ADDRESS_TO_FILLER, new Map(), now, logger);
      // combined: 2 faded / 4 total => (2+1)/(4+20) = 3/24 = 0.125
      expect(stats['fillerC'].fadeRate).toBeCloseTo(3 / 24, 6);
      expect(stats['fillerC'].duringBlockRate).toBeCloseTo(0.05, 6);
    });

    it('flags addresses whose latest-N window has outrun the streak finality horizon', () => {
      // fillerA: a full window whose OLDEST row is fresher than the finality horizon — rows
      // are being evicted before they can ever be streak-classified
      const rows: V2FadesRowType[] = [
        ...Array(ORDERS_PER_FILLER_LIMIT)
          .fill(0)
          .map((_, i) => order('0x0000000000000000000000000000000000000001', 0, now - 200 - i)),
        // fillerB: also a full window, but it still reaches past the horizon (oldest row is
        // final) — that's the designed adaptive window, not degradation
        ...Array(ORDERS_PER_FILLER_LIMIT - 1)
          .fill(0)
          .map((_, i) => order('0x0000000000000000000000000000000000000002', 0, now - 200 - i)),
        order('0x0000000000000000000000000000000000000002', 0, now - FINAL),
      ];
      const stats = getFillersFadeStats(rows, ADDRESS_TO_FILLER, new Map(), now, logger);
      expect(stats['fillerA'].saturatedAddresses).toEqual(1);
      expect(stats['fillerB'].saturatedAddresses).toEqual(0);
    });
  });

  describe('calculateBlockUntilTimestamp', () => {
    it('escalates only on consecutive blocks (no per-fade multiplier)', () => {
      expect(calculateBlockUntilTimestamp(now, 0)).toEqual(now + BASE_BLOCK_SECS);
      expect(calculateBlockUntilTimestamp(now, 1)).toEqual(now + BASE_BLOCK_SECS * 2);
      expect(calculateBlockUntilTimestamp(now, 2)).toEqual(now + BASE_BLOCK_SECS * 4);
      expect(calculateBlockUntilTimestamp(now, undefined)).toEqual(now + BASE_BLOCK_SECS);
    });

    it('caps the backoff exponent so a single increment never exceeds 32 hours', () => {
      const capped = now + BASE_BLOCK_SECS * 2 ** MAX_BLOCK_BACKOFF_EXPONENT;
      expect(calculateBlockUntilTimestamp(now, MAX_BLOCK_BACKOFF_EXPONENT)).toEqual(capped);
      expect(calculateBlockUntilTimestamp(now, MAX_BLOCK_BACKOFF_EXPONENT + 1)).toEqual(capped);
      expect(calculateBlockUntilTimestamp(now, 50)).toEqual(capped);
      expect(capped - now).toEqual(32 * 3600); // pin the intended ceiling in wall-clock terms
    });
  });

  describe('calculateNewTimestamps', () => {
    it('blocks a filler whose fade rate exceeds the threshold', () => {
      const timestamps: FillerTimestamps = new Map();
      const stats: FillerFadeStatsMap = { newBad: fadeStats({ fadeRate: 0.2, newFades: 1 }) };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row).toEqual({
        hash: 'newBad',
        lastExaminedTimestamp: now,
        blockUntilTimestamp: now + BASE_BLOCK_SECS, // 2^0
        fadeWindowStart: now + BASE_BLOCK_SECS, // floor = block end
        consecutiveBlocks: 1,
        consecutiveCleanRuns: 0, // blocked: recovery streak restarts
      });
    });

    it('does not block a filler under the threshold', () => {
      const timestamps: FillerTimestamps = new Map();
      const stats: FillerFadeStatsMap = { ok: fadeStats() };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP);
      expect(row.fadeWindowStart).toEqual(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP); // never blocked
      expect(row.consecutiveBlocks).toEqual(0);
      expect(row.consecutiveCleanRuns).toEqual(0); // no escalation to work off: no streak accumulates
    });

    it('uses consecutiveBlocks for backoff when re-blocking', () => {
      // previously blocked twice, block now expired (past), breaches again
      const timestamps: FillerTimestamps = new Map([
        ['repeat', cbState({ fadeWindowStart: now - 10, consecutiveBlocks: 2 })],
      ]);
      const stats: FillerFadeStatsMap = { repeat: fadeStats({ fadeRate: 0.3, newFades: 1 }) };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + BASE_BLOCK_SECS * 4); // 2^2 (old consecutive)
      expect(row.fadeWindowStart).toEqual(now + BASE_BLOCK_SECS * 4);
      expect(row.consecutiveBlocks).toEqual(3);
    });

    it('caps consecutiveBlocks so recovery time is bounded along with block duration', () => {
      // A filler with a long block history: the stored counter must not keep growing past the
      // backoff cap, else full recovery (consecutiveBlocks * CLEAN_RUNS_PER_DECAY clean runs)
      // grows with history and a long-reformed filler stays one fade from a max-length block.
      const timestamps: FillerTimestamps = new Map([
        ['maxed', cbState({ fadeWindowStart: now - 10, consecutiveBlocks: MAX_BLOCK_BACKOFF_EXPONENT })],
      ]);
      const stats: FillerFadeStatsMap = { maxed: fadeStats({ fadeRate: 0.3, newFades: 1 }) };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + BASE_BLOCK_SECS * 2 ** MAX_BLOCK_BACKOFF_EXPONENT);
      expect(row.consecutiveBlocks).toEqual(MAX_BLOCK_BACKOFF_EXPONENT); // counter capped too
    });

    it('clamps legacy over-cap stored consecutiveBlocks on every path, not just re-blocks', () => {
      // Rows written before the cap existed can hold values > MAX_BLOCK_BACKOFF_EXPONENT.
      // The clamp happens where stored state is read, so the keep-block and decay paths
      // normalize it too — otherwise a legacy 12 needs 12 * CLEAN_RUNS_PER_DECAY clean runs
      // to recover, violating the documented bound, and the metric charts impossible levels.
      const legacyBlocked: FillerTimestamps = new Map([
        ['legacy', cbState({ blockUntilTimestamp: now + 300, fadeWindowStart: now + 300, consecutiveBlocks: 12 })],
      ]);
      const [kept] = calculateNewTimestamps(legacyBlocked, { legacy: fadeStats() }, now, logger);
      expect(kept.consecutiveBlocks).toEqual(MAX_BLOCK_BACKOFF_EXPONENT); // normalized while benched

      const legacyDecaying: FillerTimestamps = new Map([
        ['legacy', cbState({ consecutiveBlocks: 12, consecutiveCleanRuns: CLEAN_RUNS_PER_DECAY - 1 })],
      ]);
      const [decayed] = calculateNewTimestamps(legacyDecaying, { legacy: fadeStats() }, now, logger);
      expect(decayed.consecutiveBlocks).toEqual(MAX_BLOCK_BACKOFF_EXPONENT - 1); // clamped, then decayed
    });

    it('clamps corrupted negative stored consecutiveBlocks back to zero', () => {
      // No code path writes negatives, but a manual edit or bad backfill could: unclamped,
      // decay would drive it lower and a later block would compute 2^negative — a
      // sub-base-length fractional block. The read clamp floors it at 0.
      const timestamps: FillerTimestamps = new Map([['corrupted', cbState({ consecutiveBlocks: -3 })]]);
      const stats: FillerFadeStatsMap = { corrupted: fadeStats() };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.consecutiveBlocks).toEqual(0);
      expect(row.consecutiveCleanRuns).toEqual(0);
    });

    it('resets blockUntilTimestamp but preserves fadeWindowStart when the decay streak completes', () => {
      const timestamps: FillerTimestamps = new Map([
        [
          'recovering',
          cbState({
            fadeWindowStart: now - 500,
            consecutiveBlocks: 2,
            consecutiveCleanRuns: CLEAN_RUNS_PER_DECAY - 1, // this clean run completes the streak
          }),
        ],
      ]);
      const stats: FillerFadeStatsMap = { recovering: fadeStats() };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP); // not blocked
      expect(row.fadeWindowStart).toEqual(now - 500); // clean-slate floor preserved independently
      expect(row.consecutiveBlocks).toEqual(1); // decayed 2 -> 1
      expect(row.consecutiveCleanRuns).toEqual(0); // streak restarts for the next level
    });

    it('freezes consecutiveBlocks and the clean-run streak while idle', () => {
      // A filler's stale rows can sit in the 24h view long after their block expired. Without
      // the newCompletions gate, escalation would decay every 10-minute cron run while they
      // simply idle — resetting 3 -> 0 in ~30 minutes with zero demonstrated clean fills.
      const timestamps: FillerTimestamps = new Map([
        ['idler', cbState({ consecutiveBlocks: 3, consecutiveCleanRuns: 2 })],
      ]);
      const stats: FillerFadeStatsMap = { idler: fadeStats({ newCompletions: 0 }) };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.consecutiveBlocks).toEqual(3); // frozen, not decayed
      expect(row.consecutiveCleanRuns).toEqual(2); // idle doesn't build the streak, but doesn't break it either
      expect(row.fadeWindowStart).toEqual(now - 50); // clean-slate floor preserved
    });

    it('extends the block when in-flight orders fade at over the threshold rate while blocked', () => {
      const timestamps: FillerTimestamps = new Map([
        ['blockedFader', cbState({ blockUntilTimestamp: now + 500, fadeWindowStart: now + 500, consecutiveBlocks: 1 })],
      ]);
      // post-block rate sits at the prior (blocked => empty window), but the in-flight
      // cohort faded at over the threshold rate
      const stats: FillerFadeStatsMap = { blockedFader: fadeStats({ duringBlockRate: 0.2, newFades: 1 }) };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + 500 + BASE_BLOCK_SECS * 2); // extend from current end, 2^1
      expect(row.fadeWindowStart).toEqual(now + 500 + BASE_BLOCK_SECS * 2); // floor tracks the extended end
      expect(row.consecutiveBlocks).toEqual(2);
      expect(row.consecutiveCleanRuns).toEqual(0);
    });

    it("does not extend when a blocked filler's stray in-flight fade is offset by clean fills", () => {
      const timestamps: FillerTimestamps = new Map([
        [
          'blockedBusy',
          cbState({
            blockUntilTimestamp: now + 500,
            fadeWindowStart: now + 500,
            consecutiveBlocks: 1,
            consecutiveCleanRuns: 3,
          }),
        ],
      ]);
      // 1 fade among 19 clean in-flight fills: (1+1)/(20+20) = 5% <= threshold.
      // Under the old count-based rule (newFades > 0) this high-volume filler's block
      // would have been extended by a single statistical fade.
      const stats: FillerFadeStatsMap = {
        blockedBusy: fadeStats({ duringBlockRate: laplaceSmoothedFadeRate(1, 20), newCompletions: 20, newFades: 1 }),
      };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + 500); // kept, not extended
      expect(row.consecutiveBlocks).toEqual(1);
      expect(row.consecutiveCleanRuns).toEqual(0); // but the in-flight fade still breaks the decay streak
    });

    it('re-blocks after expiry when in-flight orders faded during the block (slip-through fix)', () => {
      // The block expired between cron runs; the fades landed while it was active, so they
      // sit below the clean-slate floor (fadeRate at prior) — duringBlockRate catches them.
      const timestamps: FillerTimestamps = new Map([
        ['lateFader', cbState({ lastExaminedTimestamp: now - 400, fadeWindowStart: now - 10, consecutiveBlocks: 1 })],
      ]);
      const stats: FillerFadeStatsMap = { lateFader: fadeStats({ duringBlockRate: 0.14, newFades: 1 }) };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + BASE_BLOCK_SECS * 2); // 2^1 backoff
      expect(row.consecutiveBlocks).toEqual(2);
    });

    it('keeps an active block (no extend, no decay) when the in-flight cohort is clean', () => {
      const timestamps: FillerTimestamps = new Map([
        [
          'blockedClean',
          cbState({
            blockUntilTimestamp: now + 300,
            fadeWindowStart: now + 300,
            consecutiveBlocks: 1,
            consecutiveCleanRuns: 2,
          }),
        ],
      ]);
      // even a high (stale) window rate must not extend an active block by itself
      const stats: FillerFadeStatsMap = { blockedClean: fadeStats({ fadeRate: 0.9 }) };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + 300);
      expect(row.fadeWindowStart).toEqual(now + 300);
      expect(row.consecutiveBlocks).toEqual(1);
      // serving a bench is not recovery: clean in-flight fills don't build the decay streak
      expect(row.consecutiveCleanRuns).toEqual(2);
    });

    it('decays one escalation level only after CLEAN_RUNS_PER_DECAY consecutive clean runs', () => {
      const state = (consecutiveBlocks: number, consecutiveCleanRuns: number, lastExaminedTimestamp: number) =>
        new Map([
          ['gamer', cbState({ lastExaminedTimestamp, consecutiveBlocks, consecutiveCleanRuns })],
        ]) as FillerTimestamps;
      const clean: FillerFadeStatsMap = { gamer: fadeStats({ fadeRate: 0.04 }) };

      // clean runs build the streak without decaying until the streak completes
      let timestamps = state(3, 0, now - 100);
      for (let run = 1; run < CLEAN_RUNS_PER_DECAY; run++) {
        const [row] = calculateNewTimestamps(timestamps, clean, now + run * 600, logger);
        expect(row.consecutiveBlocks).toEqual(3); // not yet
        expect(row.consecutiveCleanRuns).toEqual(run);
        timestamps = state(row.consecutiveBlocks, row.consecutiveCleanRuns, row.lastExaminedTimestamp);
      }
      // the CLEAN_RUNS_PER_DECAY-th clean run decays one level and restarts the streak
      const [row] = calculateNewTimestamps(timestamps, clean, now + CLEAN_RUNS_PER_DECAY * 600, logger);
      expect(row.consecutiveBlocks).toEqual(2);
      expect(row.consecutiveCleanRuns).toEqual(0);
      // full recovery from 3 levels therefore costs 3 * CLEAN_RUNS_PER_DECAY clean runs
    });

    it('resets the clean-run streak on a sub-threshold fade (a fade is not recovery)', () => {
      const timestamps: FillerTimestamps = new Map([
        [
          'almostRecovered',
          cbState({ consecutiveBlocks: 2, consecutiveCleanRuns: CLEAN_RUNS_PER_DECAY - 1 }), // one clean run from a decay
        ],
      ]);
      // under threshold, but the run's one new completion faded
      const stats: FillerFadeStatsMap = { almostRecovered: fadeStats({ fadeRate: 0.09, newFades: 1 }) };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP); // still not blocked
      expect(row.consecutiveBlocks).toEqual(2); // and not decayed
      expect(row.consecutiveCleanRuns).toEqual(0); // streak restarts from scratch
    });

    it('processes a mix of fillers in one pass', () => {
      const timestamps: FillerTimestamps = new Map([
        ['blocked', cbState({ blockUntilTimestamp: now + 500, fadeWindowStart: now + 500, consecutiveBlocks: 1 })],
      ]);
      const stats: FillerFadeStatsMap = {
        breach: fadeStats({ fadeRate: 0.25, newFades: 1 }),
        clean: fadeStats({ fadeRate: 0.03 }),
        blocked: fadeStats(),
      };
      const rows: ToUpdateTimestampRow[] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(rows).toHaveLength(3);
      const byHash = Object.fromEntries(rows.map((r) => [r.hash, r]));
      expect(byHash['breach'].blockUntilTimestamp).toBeGreaterThan(now);
      expect(byHash['clean'].blockUntilTimestamp).toEqual(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP);
      expect(byHash['blocked'].blockUntilTimestamp).toEqual(now + 500); // unchanged
    });

    it('emits per-filler fade rates and new/extended block counters', () => {
      const metrics = { putMetric: jest.fn() } as any;
      const timestamps: FillerTimestamps = new Map([
        ['extendMe', cbState({ blockUntilTimestamp: now + 500, fadeWindowStart: now + 500, consecutiveBlocks: 1 })],
      ]);
      const stats: FillerFadeStatsMap = {
        breach: fadeStats({ fadeRate: 0.25, newFades: 1 }), // trips a new block
        clean: fadeStats({ fadeRate: 0.03 }),
        extendMe: fadeStats({ duringBlockRate: 0.2, newFades: 1 }), // extends an active block
      };
      calculateNewTimestamps(timestamps, stats, now, logger, metrics);

      expect(metrics.putMetric).toHaveBeenCalledWith(
        metricContext(Metric.CIRCUIT_BREAKER_V2_FADE_RATE, 'breach'),
        0.25,
        expect.anything()
      );
      expect(metrics.putMetric).toHaveBeenCalledWith(
        metricContext(Metric.CIRCUIT_BREAKER_V2_FADE_RATE, 'clean'),
        0.03,
        expect.anything()
      );
      expect(metrics.putMetric).toHaveBeenCalledWith(Metric.CIRCUIT_BREAKER_V2_NEW_BLOCKS, 1, expect.anything());
      expect(metrics.putMetric).toHaveBeenCalledWith(Metric.CIRCUIT_BREAKER_V2_EXTENDED_BLOCKS, 1, expect.anything());

      // during-block rate is charted only for the currently-blocked filler (its post-block
      // fadeRate sits at the prior while benched)
      expect(metrics.putMetric).toHaveBeenCalledWith(
        metricContext(Metric.CIRCUIT_BREAKER_V2_DURING_BLOCK_RATE, 'extendMe'),
        0.2,
        expect.anything()
      );
      expect(metrics.putMetric).not.toHaveBeenCalledWith(
        metricContext(Metric.CIRCUIT_BREAKER_V2_DURING_BLOCK_RATE, 'breach'),
        expect.anything(),
        expect.anything()
      );

      // escalation level emitted for blocked/blocking fillers; never-blocked 'clean' (0 -> 0)
      // emits nothing
      expect(metrics.putMetric).toHaveBeenCalledWith(
        metricContext(Metric.CIRCUIT_BREAKER_V2_CONSECUTIVE_BLOCKS, 'breach'),
        1,
        expect.anything()
      );
      expect(metrics.putMetric).toHaveBeenCalledWith(
        metricContext(Metric.CIRCUIT_BREAKER_V2_CONSECUTIVE_BLOCKS, 'extendMe'),
        2,
        expect.anything()
      );
      expect(metrics.putMetric).not.toHaveBeenCalledWith(
        metricContext(Metric.CIRCUIT_BREAKER_V2_CONSECUTIVE_BLOCKS, 'clean'),
        expect.anything(),
        expect.anything()
      );
    });

    it('emits the decayed escalation level so recovery is visible (steps down to 0)', () => {
      const metrics = { putMetric: jest.fn() } as any;
      const timestamps: FillerTimestamps = new Map([
        [
          'recovering',
          cbState({ consecutiveBlocks: 1, consecutiveCleanRuns: CLEAN_RUNS_PER_DECAY - 1 }), // streak completes
        ],
      ]);
      const stats: FillerFadeStatsMap = {
        recovering: fadeStats({ fadeRate: 0.03, newCompletions: 5 }), // decays 1 -> 0
      };
      calculateNewTimestamps(timestamps, stats, now, logger, metrics);

      // the step down to 0 is emitted (previousBlocks was 1), not silently dropped
      expect(metrics.putMetric).toHaveBeenCalledWith(
        metricContext(Metric.CIRCUIT_BREAKER_V2_CONSECUTIVE_BLOCKS, 'recovering'),
        0,
        expect.anything()
      );
    });

    it('emits the chronic (no-amnesty) watchlist rate only at sufficient sample size', () => {
      const metrics = { putMetric: jest.fn() } as any;
      const stats: FillerFadeStatsMap = {
        // a low-volume ~20% fader living inside the block threshold's envelope: never blocked,
        // but the watchlist metric keeps them visible
        watchme: fadeStats({ fadeRate: 0.11, chronicRate: 0.2, chronicTotal: CHRONIC_RATE_MIN_SAMPLE }),
        // below the sample gate: a single faded order must not chart as a 100% swing
        tiny: fadeStats({ fadeRate: 0.09, newFades: 1, chronicRate: 1, chronicTotal: CHRONIC_RATE_MIN_SAMPLE - 1 }),
        // below the rate floor: a healthy filler must not get a permanent flat-zero series
        healthy: fadeStats({ chronicRate: CHRONIC_RATE_EMISSION_FLOOR - 0.01, chronicTotal: 50 }),
      };
      calculateNewTimestamps(new Map(), stats, now, logger, metrics);
      expect(metrics.putMetric).toHaveBeenCalledWith(
        metricContext(Metric.CIRCUIT_BREAKER_V2_CHRONIC_RATE, 'watchme'),
        0.2,
        expect.anything()
      );
      expect(metrics.putMetric).not.toHaveBeenCalledWith(
        metricContext(Metric.CIRCUIT_BREAKER_V2_CHRONIC_RATE, 'tiny'),
        expect.anything(),
        expect.anything()
      );
      expect(metrics.putMetric).not.toHaveBeenCalledWith(
        metricContext(Metric.CIRCUIT_BREAKER_V2_CHRONIC_RATE, 'healthy'),
        expect.anything(),
        expect.anything()
      );
    });

    it('emits the aggregate count of window-saturated addresses', () => {
      const metrics = { putMetric: jest.fn() } as any;
      const stats: FillerFadeStatsMap = {
        busy: fadeStats({ saturatedAddresses: 2 }),
        quiet: fadeStats(),
      };
      calculateNewTimestamps(new Map(), stats, now, logger, metrics);
      expect(metrics.putMetric).toHaveBeenCalledWith(
        Metric.CIRCUIT_BREAKER_V2_SATURATED_ADDRESSES,
        2,
        expect.anything()
      );
    });
  });

  describe('escalation decay requires demonstrated clean activity', () => {
    // Repro of the production "Elk" profile: a chronic ~94% fader at ~1 order per 2 hours.
    // Their fades land in separate cron runs, so every post-block cycle looks like:
    //   fade #1 (window = 1 fade -> 2/21 = 9.5%, under threshold)  -> run must NOT decay
    //   fade #2 (window = 2 fades -> 3/22 = 13.6%, over threshold) -> block, +1 escalation
    // If the first (sub-threshold, faded) completion counts as recovery activity and decays
    // escalation, each cycle nets zero and consecutiveBlocks stays pinned at ~0-2 forever —
    // 15-30 minute blocks that cost a 1-order-per-2h filler nothing. Observed in prod:
    // a week of ~94% fading with consecutiveBlocks sitting at 2.
    const ELK_ADDR = '0x0000000000000000000000000000000000000005';
    const ELK_MAP = new Map<string, string>([[ELK_ADDR, 'elk']]);
    const floor = now - 20000; // last block ended ~5.5h ago (clean-slate floor)

    const elkState = (consecutiveBlocks: number, lastExaminedTimestamp: number) =>
      new Map([
        ['elk', cbState({ lastExaminedTimestamp, fadeWindowStart: floor, consecutiveBlocks })],
      ]) as FillerTimestamps;

    it('does not decay consecutiveBlocks on a run whose only new completion is a fade', () => {
      const t1 = now - 600;
      const fillerTimestamps = elkState(2, t1 - 600);
      // one faded order past the finality horizon (visible in this batch, streak-classified
      // this run); window rate (1+1)/(1+20) is under threshold
      const stats = getFillersFadeStats([order(ELK_ADDR, 1, t1 - FINAL)], ELK_MAP, fillerTimestamps, t1, logger);
      expect(stats['elk'].fadeRate).toBeLessThan(FADE_RATE_BLOCK_THRESHOLD);
      expect(stats['elk'].newFades).toEqual(1);

      const [row] = calculateNewTimestamps(fillerTimestamps, stats, t1, logger);
      expect(row.blockUntilTimestamp).toEqual(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP); // correctly not blocked yet
      expect(row.consecutiveBlocks).toEqual(2); // a faded completion is not recovery activity
    });

    it('keeps full exponential backoff across a lone-fade -> trip cycle', () => {
      const t1 = now - 600;
      const t2 = now;
      // each fade ages past the finality horizon in time for the corresponding run's slice
      const fade1 = order(ELK_ADDR, 1, t1 - FINAL);
      const fade2 = order(ELK_ADDR, 1, t2 - FINAL);

      // run 1: lone sub-threshold fade
      const state1 = elkState(2, t1 - 600);
      const stats1 = getFillersFadeStats([fade1], ELK_MAP, state1, t1, logger);
      const [row1] = calculateNewTimestamps(state1, stats1, t1, logger);

      // run 2: second fade (loaded in the next batch) puts the window at 3/22 > threshold -> block
      const state2 = new Map([
        [
          'elk',
          cbState({
            lastExaminedTimestamp: row1.lastExaminedTimestamp,
            blockUntilTimestamp: row1.blockUntilTimestamp ?? 0,
            fadeWindowStart: row1.fadeWindowStart ?? 0,
            consecutiveBlocks: row1.consecutiveBlocks,
            consecutiveCleanRuns: row1.consecutiveCleanRuns,
          }),
        ],
      ]) as FillerTimestamps;
      const stats2 = getFillersFadeStats([fade1, fade2], ELK_MAP, state2, t2, logger);
      expect(stats2['elk'].fadeRate).toBeGreaterThan(FADE_RATE_BLOCK_THRESHOLD);

      const [row2] = calculateNewTimestamps(state2, stats2, t2, logger);
      // escalation must ratchet: block computed off the preserved consecutiveBlocks=2 (2^2),
      // not a flattened level worked off by the cycle's own first fade
      expect(row2.blockUntilTimestamp).toEqual(t2 + BASE_BLOCK_SECS * 4);
      expect(row2.consecutiveBlocks).toEqual(3);
    });
  });

  describe('fadedOrderHashes persistence', () => {
    it('collects the faded order hashes per cohort in getFillersFadeStats', () => {
      const addr = '0x0000000000000000000000000000000000000001';
      const map = new Map([[addr, 'filler']]);
      // fadeWindowStart in the past: rows after it are the rate window,
      // rows on/before it (but after lastExamined) are the during-block cohort
      const timestamps: FillerTimestamps = new Map([
        ['filler', cbState({ lastExaminedTimestamp: now - 100, fadeWindowStart: now - 50 })],
      ]);
      const rows = [
        order(addr, 1, now - 10, '0xwindowfade'), // window cohort, faded
        order(addr, 0, now - 20, '0xwindowclean'), // window cohort, clean
        order(addr, 1, now - 60, '0xblockfade'), // during-block cohort, faded
        order(addr, 0, now - 70, '0xblockclean'), // during-block cohort, clean
      ];
      const stats = getFillersFadeStats(rows, map, timestamps, now, logger);
      expect(stats['filler'].windowFadedOrderHashes).toEqual(['0xwindowfade']);
      expect(stats['filler'].duringBlockFadedOrderHashes).toEqual(['0xblockfade']);
    });

    it('stores the window cohort hashes when the fade rate trips a new block', () => {
      const stats: FillerFadeStatsMap = {
        newBad: fadeStats({
          fadeRate: 0.2,
          newFades: 2,
          windowFadedOrderHashes: ['0xw1', '0xw2'],
          duringBlockFadedOrderHashes: ['0xb1'], // under threshold: not a cause
        }),
      };
      const [row] = calculateNewTimestamps(new Map(), stats, now, logger);
      expect(row.fadedOrderHashes).toEqual(['0xw1', '0xw2']);
    });

    it('stores the during-block cohort hashes when a late in-flight fade re-blocks after expiry', () => {
      const timestamps: FillerTimestamps = new Map([
        ['slip', cbState({ fadeWindowStart: now - 10, consecutiveBlocks: 1 })],
      ]);
      const stats: FillerFadeStatsMap = {
        slip: fadeStats({
          duringBlockRate: 0.3,
          newFades: 1,
          windowFadedOrderHashes: [],
          duringBlockFadedOrderHashes: ['0xinflight'],
        }),
      };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toBeGreaterThan(now);
      expect(row.fadedOrderHashes).toEqual(['0xinflight']);
    });

    it('appends the extending in-flight fades to the stored hashes when extending a block', () => {
      const timestamps: FillerTimestamps = new Map([
        [
          'blocked',
          cbState({
            blockUntilTimestamp: now + 500,
            fadeWindowStart: now + 500,
            consecutiveBlocks: 1,
            fadedOrderHashes: ['0xold'],
          }),
        ],
      ]);
      const stats: FillerFadeStatsMap = {
        blocked: fadeStats({
          duringBlockRate: 0.3,
          newFades: 1,
          windowFadedOrderHashes: [],
          duringBlockFadedOrderHashes: ['0xnew'],
        }),
      };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toBeGreaterThan(now + 500);
      expect(row.fadedOrderHashes).toEqual(['0xold', '0xnew']);
    });

    it('carries stored hashes forward when blocked with a clean in-flight cohort', () => {
      const timestamps: FillerTimestamps = new Map([
        [
          'blocked',
          cbState({
            blockUntilTimestamp: now + 500,
            fadeWindowStart: now + 500,
            consecutiveBlocks: 1,
            fadedOrderHashes: ['0xold'],
          }),
        ],
      ]);
      const stats: FillerFadeStatsMap = { blocked: fadeStats() };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + 500);
      expect(row.fadedOrderHashes).toEqual(['0xold']);
    });

    it('clears stored hashes when the filler is under threshold (block expired)', () => {
      const timestamps: FillerTimestamps = new Map([
        ['recovered', cbState({ fadeWindowStart: now - 50, consecutiveBlocks: 1, fadedOrderHashes: ['0xold'] })],
      ]);
      const stats: FillerFadeStatsMap = { recovered: fadeStats() };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP);
      expect(row.fadedOrderHashes).toBeUndefined();
    });

    it('dedupes and caps stored hashes at MAX_FADED_ORDER_HASHES, keeping the most recent', () => {
      const existing = Array.from({ length: MAX_FADED_ORDER_HASHES }, (_, i) => `0x${i}`);
      const timestamps: FillerTimestamps = new Map([
        [
          'blocked',
          cbState({
            blockUntilTimestamp: now + 500,
            fadeWindowStart: now + 500,
            consecutiveBlocks: 1,
            fadedOrderHashes: existing,
          }),
        ],
      ]);
      const stats: FillerFadeStatsMap = {
        blocked: fadeStats({
          duringBlockRate: 0.3,
          newFades: 2,
          duringBlockFadedOrderHashes: ['0x1', '0xnew'], // '0x1' is already stored
        }),
      };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      const hashes = row.fadedOrderHashes!;
      expect(hashes.length).toBe(MAX_FADED_ORDER_HASHES);
      expect(hashes[hashes.length - 1]).toBe('0xnew');
      expect(hashes).not.toContain('0x0'); // oldest dropped
      expect(hashes.filter((h) => h === '0x1').length).toBe(1); // deduped
    });
  });

  describe('countActiveBlocks', () => {
    it('counts benched fillers across stored and updated state, updates taking precedence', () => {
      const timestamps: FillerTimestamps = new Map([
        // benched with no completions this run: no update row, still active
        ['benchedIdle', cbState({ blockUntilTimestamp: now + 500, fadeWindowStart: now + 500, consecutiveBlocks: 1 })],
        // recovered: past block, no update
        ['recovered', cbState()],
        // stored state says unblocked, but this run blocks them
        ['justBlocked', cbState()],
      ]);
      const updated: ToUpdateTimestampRow[] = [
        {
          hash: 'justBlocked',
          lastExaminedTimestamp: now,
          blockUntilTimestamp: now + 900,
          fadeWindowStart: now + 900,
          consecutiveBlocks: 1,
          consecutiveCleanRuns: 0,
        },
        {
          hash: 'newClean',
          lastExaminedTimestamp: now,
          blockUntilTimestamp: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
          fadeWindowStart: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
          consecutiveBlocks: 0,
          consecutiveCleanRuns: 0,
        },
      ];
      expect(countActiveBlocks(timestamps, updated, now)).toEqual(2); // benchedIdle + justBlocked
    });

    it('treats an unset (0 / undefined) blockUntilTimestamp as unblocked', () => {
      const timestamps: FillerTimestamps = new Map([
        ['unsetRow', cbState({ lastExaminedTimestamp: 1, fadeWindowStart: 0 })],
      ]);
      const updated: ToUpdateTimestampRow[] = [
        {
          hash: 'undefRow',
          lastExaminedTimestamp: now,
          blockUntilTimestamp: undefined,
          consecutiveBlocks: 0,
          consecutiveCleanRuns: 0,
        },
      ];
      expect(countActiveBlocks(timestamps, updated, now)).toEqual(0);
    });
  });
});
