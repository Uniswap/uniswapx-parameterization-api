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
      // (0 + 1) / (0 + 1 + 20) = 1/21 ≈ 0.0476
      expect(laplaceSmoothedFadeRate(0, 0)).toBeCloseTo(LAPLACE_ALPHA / (LAPLACE_ALPHA + LAPLACE_BETA), 6);
      expect(laplaceSmoothedFadeRate(0, 0)).toBeCloseTo(0.0476, 4);
    });

    it('pulls small samples toward the prior', () => {
      // raw 50% (1/2) -> (1+1)/(2+21) ≈ 0.087, well under the 12% threshold
      expect(laplaceSmoothedFadeRate(1, 2)).toBeCloseTo(2 / 23, 6);
      expect(laplaceSmoothedFadeRate(1, 2)).toBeLessThan(FADE_RATE_BLOCK_THRESHOLD);
    });

    it('converges to the empirical rate with volume', () => {
      // sustained 50% on 50 samples -> clearly over threshold
      expect(laplaceSmoothedFadeRate(25, 50)).toBeCloseTo(26 / 71, 6);
      expect(laplaceSmoothedFadeRate(25, 50)).toBeGreaterThan(FADE_RATE_BLOCK_THRESHOLD);
      // high volume, low rate stays safe
      expect(laplaceSmoothedFadeRate(3, 500)).toBeLessThan(FADE_RATE_BLOCK_THRESHOLD);
    });
  });

  describe('getFillersFadeStats', () => {
    const ADDRESS_TO_FILLER = new Map<string, string>([
      ['0x0000000000000000000000000000000000000001', 'fillerA'],
      ['0x0000000000000000000000000000000000000002', 'fillerB'],
      ['0x0000000000000000000000000000000000000003', 'fillerC'],
      ['0x0000000000000000000000000000000000000004', 'fillerC'],
    ]);

    it('computes the smoothed rate and new fades for a filler with no prior timestamp', () => {
      const rows: V2FadesRowType[] = [
        ...Array(3)
          .fill(0)
          .map(() => order('0x0000000000000000000000000000000000000001', 1, now - 50)),
        ...Array(7)
          .fill(0)
          .map(() => order('0x0000000000000000000000000000000000000001', 0, now - 50)),
      ];
      const stats = getFillersFadeStats(rows, ADDRESS_TO_FILLER, new Map(), logger);
      // window = all 10 orders (no prior block), rate = (3+1)/(10+21) = 4/31
      expect(stats['fillerA'].fadeRate).toBeCloseTo(4 / 31, 6);
      // no timestamp => every fade counts as new
      expect(stats['fillerA'].newFades).toEqual(3);
    });

    it('excludes pre-block orders from the rate window and new fades', () => {
      const fillerTimestamps: FillerTimestamps = new Map([
        ['fillerB', { lastPostTimestamp: now - 150, blockUntilTimestamp: now - 200, consecutiveBlocks: 1 }],
      ]);
      const rows: V2FadesRowType[] = [
        // pre-block fades (deadline now-300, before block end now-200): excluded from window;
        // also before lastPostTimestamp (now-150) so excluded from newFades
        order('0x0000000000000000000000000000000000000002', 1, now - 300),
        order('0x0000000000000000000000000000000000000002', 1, now - 300),
        // post-block orders (deadline now-100): 1 faded + 4 clean
        order('0x0000000000000000000000000000000000000002', 1, now - 100),
        ...Array(4)
          .fill(0)
          .map(() => order('0x0000000000000000000000000000000000000002', 0, now - 100)),
      ];
      const stats = getFillersFadeStats(rows, ADDRESS_TO_FILLER, fillerTimestamps, logger);
      // window = 5 post-block orders, 1 faded => (1+1)/(5+21) = 2/26
      expect(stats['fillerB'].fadeRate).toBeCloseTo(2 / 26, 6);
      // only the post-block fade is newer than lastPostTimestamp
      expect(stats['fillerB'].newFades).toEqual(1);
    });

    it('aggregates multiple addresses belonging to the same filler', () => {
      const rows: V2FadesRowType[] = [
        order('0x0000000000000000000000000000000000000003', 1, now - 40),
        order('0x0000000000000000000000000000000000000004', 1, now - 40),
        order('0x0000000000000000000000000000000000000004', 0, now - 40),
        order('0x0000000000000000000000000000000000000004', 0, now - 40),
      ];
      const stats = getFillersFadeStats(rows, ADDRESS_TO_FILLER, new Map(), logger);
      // combined: 2 faded / 4 total => (2+1)/(4+21) = 3/25 = 0.12
      expect(stats['fillerC'].fadeRate).toBeCloseTo(3 / 25, 6);
      expect(stats['fillerC'].newFades).toEqual(2);
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
      // all 10 orders counted: (4+1)/(10+21) = 5/31 ≈ 0.161 > threshold
      expect(stats['fillerA'].fadeRate).toBeCloseTo(5 / 31, 6);
      expect(stats['fillerA'].fadeRate).toBeGreaterThan(FADE_RATE_BLOCK_THRESHOLD);
      expect(stats['fillerA'].newFades).toEqual(4);
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
      const stats: FillerFadeStatsMap = { newBad: { fadeRate: 0.2, newFades: 3 } };
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
      const stats: FillerFadeStatsMap = { corrupt: { fadeRate: 0.04, newFades: 0 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      // NaN floor is normalized back to the unblocked sentinel, not written back as NaN
      expect(row.blockUntilTimestamp).toEqual(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP);
      expect(Number.isNaN(row.blockUntilTimestamp)).toBe(false);
      expect(row.consecutiveBlocks).toEqual(0);
    });

    it('does not block a filler under the threshold', () => {
      const timestamps: FillerTimestamps = new Map();
      const stats: FillerFadeStatsMap = { ok: { fadeRate: 0.05, newFades: 0 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP);
      expect(row.consecutiveBlocks).toEqual(0);
    });

    it('uses consecutiveBlocks for backoff when re-blocking', () => {
      // previously blocked twice, block now expired (past), breaches again
      const timestamps: FillerTimestamps = new Map([
        ['repeat', { lastPostTimestamp: now - 100, blockUntilTimestamp: now - 10, consecutiveBlocks: 2 }],
      ]);
      const stats: FillerFadeStatsMap = { repeat: { fadeRate: 0.3, newFades: 1 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + BASE_BLOCK_SECS * 4); // 2^2 (old consecutive)
      expect(row.consecutiveBlocks).toEqual(3);
    });

    it('preserves the past blockUntilTimestamp as the clean-slate floor while decaying', () => {
      const timestamps: FillerTimestamps = new Map([
        ['recovering', { lastPostTimestamp: now - 100, blockUntilTimestamp: now - 500, consecutiveBlocks: 2 }],
      ]);
      const stats: FillerFadeStatsMap = { recovering: { fadeRate: 0.05, newFades: 0 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      // block end is kept (not reset to 0) so the rate window stays scoped to post-block orders
      expect(row.blockUntilTimestamp).toEqual(now - 500);
      expect(row.consecutiveBlocks).toEqual(1); // decayed 2 -> 1
    });

    it('extends the block when a blocked filler fades again on in-flight orders', () => {
      const timestamps: FillerTimestamps = new Map([
        ['blockedFader', { lastPostTimestamp: now - 100, blockUntilTimestamp: now + 500, consecutiveBlocks: 1 }],
      ]);
      // rate is near the prior (blocked => empty window), but new in-flight fades arrived
      const stats: FillerFadeStatsMap = { blockedFader: { fadeRate: 0.05, newFades: 2 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + 500 + BASE_BLOCK_SECS * 2); // extend from current end, 2^1
      expect(row.consecutiveBlocks).toEqual(2);
    });

    it('keeps an active block (no extend, no decay) when a blocked filler has no new fades', () => {
      const timestamps: FillerTimestamps = new Map([
        ['blockedClean', { lastPostTimestamp: now - 100, blockUntilTimestamp: now + 300, consecutiveBlocks: 1 }],
      ]);
      // even a high rate must not extend while blocked without new fades
      const stats: FillerFadeStatsMap = { blockedClean: { fadeRate: 0.9, newFades: 0 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + 300);
      expect(row.consecutiveBlocks).toEqual(1);
    });

    it('requires multiple clean cycles to fully decay consecutiveBlocks (anti-gaming)', () => {
      const timestamps: FillerTimestamps = new Map([
        ['gamer', { lastPostTimestamp: now - 100, blockUntilTimestamp: now - 50, consecutiveBlocks: 3 }],
      ]);
      const clean: FillerFadeStatsMap = { gamer: { fadeRate: 0.04, newFades: 0 } };

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
        breach: { fadeRate: 0.25, newFades: 2 },
        clean: { fadeRate: 0.03, newFades: 0 },
        blocked: { fadeRate: 0.05, newFades: 0 },
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
