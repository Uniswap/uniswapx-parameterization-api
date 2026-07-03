import Logger from 'bunyan';

import {
  BASE_BLOCK_SECS,
  calculateBlockUntilTimestamp,
  calculateNewTimestamps,
  FADE_RATE_BLOCK_THRESHOLD,
  FillerFadeStatsMap,
  FillerTimestamps,
  getFillersFadeStats,
  laplaceSmoothedFadeRate,
  LAPLACE_ALPHA,
  LAPLACE_BETA,
  UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
} from '../../lib/cron/fade-rate-v2';
import { ToUpdateTimestampRow, V2FadesRowType } from '../../lib/repositories';

const now = Math.floor(Date.now() / 1000);

// silent logger in tests
const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

// helper to build a faded/non-faded order row
const order = (fillerAddress: string, faded: 0 | 1, deadline: number): V2FadesRowType => ({
  fillerAddress,
  faded,
  postTimestamp: deadline - 20,
  deadline,
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
          .map(() => order('0x0000000000000000000000000000000000000001', 1, now - 50)),
        ...Array(7)
          .fill(0)
          .map(() => order('0x0000000000000000000000000000000000000001', 0, now - 50)),
      ];
      const stats = getFillersFadeStats(rows, ADDRESS_TO_FILLER, new Map(), logger);
      // window = all 10 orders (no prior block), rate = (3+1)/(10+20) = 4/30
      expect(stats['fillerA'].fadeRate).toBeCloseTo(4 / 30, 6);
      // never blocked => empty during-block cohort => prior mean
      expect(stats['fillerA'].duringBlockRate).toBeCloseTo(0.05, 6);
    });

    it('excludes pre-block orders from the rate window', () => {
      const fillerTimestamps: FillerTimestamps = new Map([
        ['fillerB', { lastPostTimestamp: now - 150, blockUntilTimestamp: now - 200, consecutiveBlocks: 1 }],
      ]);
      const rows: V2FadesRowType[] = [
        // pre-block fades (deadline now-300, before block end now-200): excluded from window;
        // also before lastPostTimestamp (now-150) so not part of the during-block cohort
        order('0x0000000000000000000000000000000000000002', 1, now - 300),
        order('0x0000000000000000000000000000000000000002', 1, now - 300),
        // post-block orders (deadline now-100): 1 faded + 4 clean
        order('0x0000000000000000000000000000000000000002', 1, now - 100),
        ...Array(4)
          .fill(0)
          .map(() => order('0x0000000000000000000000000000000000000002', 0, now - 100)),
      ];
      const stats = getFillersFadeStats(rows, ADDRESS_TO_FILLER, fillerTimestamps, logger);
      // window = 5 post-block orders, 1 faded => (1+1)/(5+20) = 2/25
      expect(stats['fillerB'].fadeRate).toBeCloseTo(2 / 25, 6);
      // stale pre-block fades don't resurrect as a during-block cohort
      expect(stats['fillerB'].duringBlockRate).toBeCloseTo(0.05, 6);
    });

    it('scores in-flight orders that completed during a block, even after it expired', () => {
      // Block ran until now-100 and has expired; the last cron run was at now-400 (while
      // blocked). Orders completed in between (deadline in (now-400, now-100]) were in
      // flight during the block: below the clean-slate floor, so they never enter the
      // post-block window — the during-block cohort is the only path that scores them.
      const fillerTimestamps: FillerTimestamps = new Map([
        ['fillerB', { lastPostTimestamp: now - 400, blockUntilTimestamp: now - 100, consecutiveBlocks: 1 }],
      ]);
      const rows: V2FadesRowType[] = [
        // during-block cohort: 2 faded + 1 clean
        order('0x0000000000000000000000000000000000000002', 1, now - 200),
        order('0x0000000000000000000000000000000000000002', 1, now - 200),
        order('0x0000000000000000000000000000000000000002', 0, now - 200),
        // post-block window: 1 clean
        order('0x0000000000000000000000000000000000000002', 0, now - 50),
      ];
      const stats = getFillersFadeStats(rows, ADDRESS_TO_FILLER, fillerTimestamps, logger);
      // cohort = (2+1)/(3+20) = 3/23 ≈ 13.0% > threshold => calculateNewTimestamps re-blocks
      expect(stats['fillerB'].duringBlockRate).toBeCloseTo(3 / 23, 6);
      expect(stats['fillerB'].duringBlockRate).toBeGreaterThan(FADE_RATE_BLOCK_THRESHOLD);
      // window = 1 clean post-block order
      expect(stats['fillerB'].fadeRate).toBeCloseTo(1 / 21, 6);
    });

    it('aggregates multiple addresses belonging to the same filler', () => {
      const rows: V2FadesRowType[] = [
        order('0x0000000000000000000000000000000000000003', 1, now - 40),
        order('0x0000000000000000000000000000000000000004', 1, now - 40),
        order('0x0000000000000000000000000000000000000004', 0, now - 40),
        order('0x0000000000000000000000000000000000000004', 0, now - 40),
      ];
      const stats = getFillersFadeStats(rows, ADDRESS_TO_FILLER, new Map(), logger);
      // combined: 2 faded / 4 total => (2+1)/(4+20) = 3/24 = 0.125
      expect(stats['fillerC'].fadeRate).toBeCloseTo(3 / 24, 6);
      expect(stats['fillerC'].duringBlockRate).toBeCloseTo(0.05, 6);
    });

    it('treats a non-finite (NaN) stored timestamp as unset, not silently zeroing the window', () => {
      // A corrupted/missing Dynamo attribute parses to NaN. `deadline > NaN` is always
      // false, so without the guard windowTotal would stay 0 and the filler could never
      // be blocked. With the guard, NaN behaves like "unset" (floor 0) => all orders count.
      const fillerTimestamps: FillerTimestamps = new Map([
        ['fillerA', { lastPostTimestamp: NaN, blockUntilTimestamp: NaN, consecutiveBlocks: NaN }],
      ]);
      const rows: V2FadesRowType[] = [
        ...Array(4)
          .fill(0)
          .map(() => order('0x0000000000000000000000000000000000000001', 1, now - 50)),
        ...Array(6)
          .fill(0)
          .map(() => order('0x0000000000000000000000000000000000000001', 0, now - 50)),
      ];
      const stats = getFillersFadeStats(rows, ADDRESS_TO_FILLER, fillerTimestamps, logger);
      // all 10 orders counted: (4+1)/(10+20) = 5/30 ≈ 0.167 > threshold
      expect(stats['fillerA'].fadeRate).toBeCloseTo(5 / 30, 6);
      expect(stats['fillerA'].fadeRate).toBeGreaterThan(FADE_RATE_BLOCK_THRESHOLD);
      // NaN floor coerces to the unset sentinel, so no during-block cohort exists
      expect(stats['fillerA'].duringBlockRate).toBeCloseTo(0.05, 6);
    });
  });

  describe('calculateBlockUntilTimestamp', () => {
    it('escalates only on consecutive blocks (no per-fade multiplier)', () => {
      expect(calculateBlockUntilTimestamp(now, 0)).toEqual(now + BASE_BLOCK_SECS);
      expect(calculateBlockUntilTimestamp(now, 1)).toEqual(now + BASE_BLOCK_SECS * 2);
      expect(calculateBlockUntilTimestamp(now, 2)).toEqual(now + BASE_BLOCK_SECS * 4);
      expect(calculateBlockUntilTimestamp(now, undefined)).toEqual(now + BASE_BLOCK_SECS);
    });
  });

  describe('calculateNewTimestamps', () => {
    it('blocks a filler whose fade rate exceeds the threshold', () => {
      const timestamps: FillerTimestamps = new Map();
      const stats: FillerFadeStatsMap = { newBad: { fadeRate: 0.2, duringBlockRate: 0.05 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row).toEqual({
        hash: 'newBad',
        lastPostTimestamp: now,
        blockUntilTimestamp: now + BASE_BLOCK_SECS, // 2^0
        consecutiveBlocks: 1,
      });
    });

    it('does not re-persist a non-finite (NaN) blockUntilTimestamp in the decay branch', () => {
      const timestamps: FillerTimestamps = new Map([
        ['corrupt', { lastPostTimestamp: NaN, blockUntilTimestamp: NaN, consecutiveBlocks: NaN }],
      ]);
      const stats: FillerFadeStatsMap = { corrupt: { fadeRate: 0.04, duringBlockRate: 0.05 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      // NaN floor is normalized back to the unblocked sentinel, not written back as NaN
      expect(row.blockUntilTimestamp).toEqual(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP);
      expect(Number.isNaN(row.blockUntilTimestamp)).toBe(false);
      expect(row.consecutiveBlocks).toEqual(0);
    });

    it('does not block a filler under the threshold', () => {
      const timestamps: FillerTimestamps = new Map();
      const stats: FillerFadeStatsMap = { ok: { fadeRate: 0.05, duringBlockRate: 0.05 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP);
      expect(row.consecutiveBlocks).toEqual(0);
    });

    it('uses consecutiveBlocks for backoff when re-blocking', () => {
      // previously blocked twice, block now expired (past), breaches again
      const timestamps: FillerTimestamps = new Map([
        ['repeat', { lastPostTimestamp: now - 100, blockUntilTimestamp: now - 10, consecutiveBlocks: 2 }],
      ]);
      const stats: FillerFadeStatsMap = { repeat: { fadeRate: 0.3, duringBlockRate: 0.05 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + BASE_BLOCK_SECS * 4); // 2^2 (old consecutive)
      expect(row.consecutiveBlocks).toEqual(3);
    });

    it('preserves the past blockUntilTimestamp as the clean-slate floor while decaying', () => {
      const timestamps: FillerTimestamps = new Map([
        ['recovering', { lastPostTimestamp: now - 100, blockUntilTimestamp: now - 500, consecutiveBlocks: 2 }],
      ]);
      const stats: FillerFadeStatsMap = { recovering: { fadeRate: 0.05, duringBlockRate: 0.05 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      // block end is kept (not reset to 0) so the rate window stays scoped to post-block orders
      expect(row.blockUntilTimestamp).toEqual(now - 500);
      expect(row.consecutiveBlocks).toEqual(1); // decayed 2 -> 1
    });

    it('extends the block when in-flight orders fade at over the threshold rate while blocked', () => {
      const timestamps: FillerTimestamps = new Map([
        ['blockedFader', { lastPostTimestamp: now - 100, blockUntilTimestamp: now + 500, consecutiveBlocks: 1 }],
      ]);
      // post-block rate sits at the prior (blocked => empty window), but the in-flight
      // cohort faded at over the threshold rate
      const stats: FillerFadeStatsMap = { blockedFader: { fadeRate: 0.05, duringBlockRate: 0.2 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + 500 + BASE_BLOCK_SECS * 2); // extend from current end, 2^1
      expect(row.consecutiveBlocks).toEqual(2);
    });

    it("does not extend when a blocked filler's stray in-flight fade is offset by clean fills", () => {
      const timestamps: FillerTimestamps = new Map([
        ['blockedBusy', { lastPostTimestamp: now - 100, blockUntilTimestamp: now + 500, consecutiveBlocks: 1 }],
      ]);
      // 1 fade among 19 clean in-flight fills: (1+1)/(20+20) = 5% <= threshold.
      // Under the old count-based rule (newFades > 0) this high-volume filler's block
      // would have been extended by a single statistical fade.
      const stats: FillerFadeStatsMap = {
        blockedBusy: { fadeRate: 0.05, duringBlockRate: laplaceSmoothedFadeRate(1, 20) },
      };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + 500); // kept, not extended
      expect(row.consecutiveBlocks).toEqual(1);
    });

    it('re-blocks after expiry when in-flight orders faded during the block (slip-through fix)', () => {
      // The block expired between cron runs; the fades landed while it was active, so they
      // sit below the clean-slate floor (fadeRate at prior) — duringBlockRate catches them.
      const timestamps: FillerTimestamps = new Map([
        ['lateFader', { lastPostTimestamp: now - 400, blockUntilTimestamp: now - 10, consecutiveBlocks: 1 }],
      ]);
      const stats: FillerFadeStatsMap = { lateFader: { fadeRate: 0.05, duringBlockRate: 0.14 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + BASE_BLOCK_SECS * 2); // 2^1 backoff
      expect(row.consecutiveBlocks).toEqual(2);
    });

    it('keeps an active block (no extend, no decay) when the in-flight cohort is clean', () => {
      const timestamps: FillerTimestamps = new Map([
        ['blockedClean', { lastPostTimestamp: now - 100, blockUntilTimestamp: now + 300, consecutiveBlocks: 1 }],
      ]);
      // even a high (stale) window rate must not extend an active block by itself
      const stats: FillerFadeStatsMap = { blockedClean: { fadeRate: 0.9, duringBlockRate: 0.05 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + 300);
      expect(row.consecutiveBlocks).toEqual(1);
    });

    it('requires multiple clean cycles to fully decay consecutiveBlocks (anti-gaming)', () => {
      const timestamps: FillerTimestamps = new Map([
        ['gamer', { lastPostTimestamp: now - 100, blockUntilTimestamp: now - 50, consecutiveBlocks: 3 }],
      ]);
      const clean: FillerFadeStatsMap = { gamer: { fadeRate: 0.04, duringBlockRate: 0.05 } };

      let row = calculateNewTimestamps(timestamps, clean, now, logger)[0];
      expect(row.consecutiveBlocks).toEqual(2);

      timestamps.set('gamer', {
        lastPostTimestamp: row.lastPostTimestamp,
        blockUntilTimestamp: row.blockUntilTimestamp ?? now - 50,
        consecutiveBlocks: row.consecutiveBlocks,
      });
      row = calculateNewTimestamps(timestamps, clean, now + 300, logger)[0];
      expect(row.consecutiveBlocks).toEqual(1);

      timestamps.set('gamer', {
        lastPostTimestamp: row.lastPostTimestamp,
        blockUntilTimestamp: row.blockUntilTimestamp ?? now - 50,
        consecutiveBlocks: row.consecutiveBlocks,
      });
      row = calculateNewTimestamps(timestamps, clean, now + 600, logger)[0];
      expect(row.consecutiveBlocks).toEqual(0);
    });

    it('processes a mix of fillers in one pass', () => {
      const timestamps: FillerTimestamps = new Map([
        ['blocked', { lastPostTimestamp: now - 100, blockUntilTimestamp: now + 500, consecutiveBlocks: 1 }],
      ]);
      const stats: FillerFadeStatsMap = {
        breach: { fadeRate: 0.25, duringBlockRate: 0.05 },
        clean: { fadeRate: 0.03, duringBlockRate: 0.05 },
        blocked: { fadeRate: 0.05, duringBlockRate: 0.05 },
      };
      const rows: ToUpdateTimestampRow[] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(rows).toHaveLength(3);
      const byHash = Object.fromEntries(rows.map((r) => [r.hash, r]));
      expect(byHash['breach'].blockUntilTimestamp).toBeGreaterThan(now);
      expect(byHash['clean'].blockUntilTimestamp).toEqual(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP);
      expect(byHash['blocked'].blockUntilTimestamp).toEqual(now + 500); // unchanged
    });
  });
});
