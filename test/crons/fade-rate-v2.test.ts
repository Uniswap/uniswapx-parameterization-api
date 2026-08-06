import Logger from 'bunyan';

import {
  BASE_BLOCK_SECS,
  calculateBlockUntilTimestamp,
  calculateNewTimestamps,
  countActiveBlocks,
  FADE_RATE_BLOCK_THRESHOLD,
  FillerFadeStatsMap,
  FillerTimestamps,
  getFillersFadeStats,
  laplaceSmoothedFadeRate,
  LAPLACE_ALPHA,
  LAPLACE_BETA,
  MAX_FADED_ORDER_HASHES,
  UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
} from '../../lib/cron/fade-rate-v2';
import { Metric, metricContext } from '../../lib/entities';
import { ToUpdateTimestampRow, V2FadesRowType } from '../../lib/repositories';

const now = Math.floor(Date.now() / 1000);

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
      // no prior timestamp => every completion is new
      expect(stats['fillerA'].newCompletions).toEqual(10);
    });

    it('excludes pre-block orders from the rate window', () => {
      const fillerTimestamps: FillerTimestamps = new Map([
        // fadeWindowStart (the clean-slate floor) is the last block end at now-200
        [
          'fillerB',
          {
            lastExaminedTimestamp: now - 150,
            blockUntilTimestamp: 0,
            fadeWindowStart: now - 200,
            consecutiveBlocks: 1,
          },
        ],
      ]);
      const rows: V2FadesRowType[] = [
        // pre-block fades (deadline now-300, before block end now-200): excluded from window;
        // also before lastExaminedTimestamp (now-150) so not part of the during-block cohort
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
      // only the 5 post-lastPost orders are new completions
      expect(stats['fillerB'].newCompletions).toEqual(5);
    });

    it('scores in-flight orders that completed during a block, even after it expired', () => {
      // Block ran until now-100 and has expired; the last cron run was at now-400 (while
      // blocked). Orders completed in between (deadline in (now-400, now-100]) were in
      // flight during the block: below the clean-slate floor, so they never enter the
      // post-block window — the during-block cohort is the only path that scores them.
      const fillerTimestamps: FillerTimestamps = new Map([
        // block ended at now-100 => fadeWindowStart is now-100; last cron run at now-400
        [
          'fillerB',
          {
            lastExaminedTimestamp: now - 400,
            blockUntilTimestamp: 0,
            fadeWindowStart: now - 100,
            consecutiveBlocks: 1,
          },
        ],
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
      expect(stats['fillerB'].newCompletions).toEqual(4);
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
      const stats: FillerFadeStatsMap = { newBad: { fadeRate: 0.2, duringBlockRate: 0.05, newCompletions: 1 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row).toEqual({
        hash: 'newBad',
        lastExaminedTimestamp: now,
        blockUntilTimestamp: now + BASE_BLOCK_SECS, // 2^0
        fadeWindowStart: now + BASE_BLOCK_SECS, // floor = block end
        consecutiveBlocks: 1,
      });
    });

    it('does not block a filler under the threshold', () => {
      const timestamps: FillerTimestamps = new Map();
      const stats: FillerFadeStatsMap = { ok: { fadeRate: 0.05, duringBlockRate: 0.05, newCompletions: 1 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP);
      expect(row.fadeWindowStart).toEqual(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP); // never blocked
      expect(row.consecutiveBlocks).toEqual(0);
    });

    it('uses consecutiveBlocks for backoff when re-blocking', () => {
      // previously blocked twice, block now expired (past), breaches again
      const timestamps: FillerTimestamps = new Map([
        [
          'repeat',
          { lastExaminedTimestamp: now - 100, blockUntilTimestamp: 0, fadeWindowStart: now - 10, consecutiveBlocks: 2 },
        ],
      ]);
      const stats: FillerFadeStatsMap = { repeat: { fadeRate: 0.3, duringBlockRate: 0.05, newCompletions: 1 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + BASE_BLOCK_SECS * 4); // 2^2 (old consecutive)
      expect(row.fadeWindowStart).toEqual(now + BASE_BLOCK_SECS * 4);
      expect(row.consecutiveBlocks).toEqual(3);
    });

    it('resets blockUntilTimestamp but preserves fadeWindowStart while decaying', () => {
      const timestamps: FillerTimestamps = new Map([
        [
          'recovering',
          {
            lastExaminedTimestamp: now - 100,
            blockUntilTimestamp: 0,
            fadeWindowStart: now - 500,
            consecutiveBlocks: 2,
          },
        ],
      ]);
      const stats: FillerFadeStatsMap = { recovering: { fadeRate: 0.05, duringBlockRate: 0.05, newCompletions: 1 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP); // not blocked
      expect(row.fadeWindowStart).toEqual(now - 500); // clean-slate floor preserved independently
      expect(row.consecutiveBlocks).toEqual(1); // decayed 2 -> 1
    });

    it('freezes consecutiveBlocks while idle: no new completions means no decay', () => {
      // A filler's stale rows can sit in the 24h view long after their block expired. Without
      // the newCompletions gate, escalation would decay every 10-minute cron run while they
      // simply idle — resetting 3 -> 0 in ~30 minutes with zero demonstrated clean fills.
      const timestamps: FillerTimestamps = new Map([
        [
          'idler',
          { lastExaminedTimestamp: now - 100, blockUntilTimestamp: 0, fadeWindowStart: now - 50, consecutiveBlocks: 3 },
        ],
      ]);
      const stats: FillerFadeStatsMap = { idler: { fadeRate: 0.05, duringBlockRate: 0.05, newCompletions: 0 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.consecutiveBlocks).toEqual(3); // frozen, not decayed
      expect(row.fadeWindowStart).toEqual(now - 50); // clean-slate floor preserved
    });

    it('extends the block when in-flight orders fade at over the threshold rate while blocked', () => {
      const timestamps: FillerTimestamps = new Map([
        [
          'blockedFader',
          {
            lastExaminedTimestamp: now - 100,
            blockUntilTimestamp: now + 500,
            fadeWindowStart: now + 500,
            consecutiveBlocks: 1,
          },
        ],
      ]);
      // post-block rate sits at the prior (blocked => empty window), but the in-flight
      // cohort faded at over the threshold rate
      const stats: FillerFadeStatsMap = { blockedFader: { fadeRate: 0.05, duringBlockRate: 0.2, newCompletions: 1 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + 500 + BASE_BLOCK_SECS * 2); // extend from current end, 2^1
      expect(row.fadeWindowStart).toEqual(now + 500 + BASE_BLOCK_SECS * 2); // floor tracks the extended end
      expect(row.consecutiveBlocks).toEqual(2);
    });

    it("does not extend when a blocked filler's stray in-flight fade is offset by clean fills", () => {
      const timestamps: FillerTimestamps = new Map([
        [
          'blockedBusy',
          {
            lastExaminedTimestamp: now - 100,
            blockUntilTimestamp: now + 500,
            fadeWindowStart: now + 500,
            consecutiveBlocks: 1,
          },
        ],
      ]);
      // 1 fade among 19 clean in-flight fills: (1+1)/(20+20) = 5% <= threshold.
      // Under the old count-based rule (newFades > 0) this high-volume filler's block
      // would have been extended by a single statistical fade.
      const stats: FillerFadeStatsMap = {
        blockedBusy: { fadeRate: 0.05, duringBlockRate: laplaceSmoothedFadeRate(1, 20), newCompletions: 1 },
      };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + 500); // kept, not extended
      expect(row.consecutiveBlocks).toEqual(1);
    });

    it('re-blocks after expiry when in-flight orders faded during the block (slip-through fix)', () => {
      // The block expired between cron runs; the fades landed while it was active, so they
      // sit below the clean-slate floor (fadeRate at prior) — duringBlockRate catches them.
      const timestamps: FillerTimestamps = new Map([
        [
          'lateFader',
          { lastExaminedTimestamp: now - 400, blockUntilTimestamp: 0, fadeWindowStart: now - 10, consecutiveBlocks: 1 },
        ],
      ]);
      const stats: FillerFadeStatsMap = { lateFader: { fadeRate: 0.05, duringBlockRate: 0.14, newCompletions: 1 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + BASE_BLOCK_SECS * 2); // 2^1 backoff
      expect(row.consecutiveBlocks).toEqual(2);
    });

    it('keeps an active block (no extend, no decay) when the in-flight cohort is clean', () => {
      const timestamps: FillerTimestamps = new Map([
        [
          'blockedClean',
          {
            lastExaminedTimestamp: now - 100,
            blockUntilTimestamp: now + 300,
            fadeWindowStart: now + 300,
            consecutiveBlocks: 1,
          },
        ],
      ]);
      // even a high (stale) window rate must not extend an active block by itself
      const stats: FillerFadeStatsMap = { blockedClean: { fadeRate: 0.9, duringBlockRate: 0.05, newCompletions: 1 } };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + 300);
      expect(row.fadeWindowStart).toEqual(now + 300);
      expect(row.consecutiveBlocks).toEqual(1);
    });

    it('requires multiple clean cycles to fully decay consecutiveBlocks (anti-gaming)', () => {
      const timestamps: FillerTimestamps = new Map([
        [
          'gamer',
          { lastExaminedTimestamp: now - 100, blockUntilTimestamp: 0, fadeWindowStart: now - 50, consecutiveBlocks: 3 },
        ],
      ]);
      const clean: FillerFadeStatsMap = { gamer: { fadeRate: 0.04, duringBlockRate: 0.05, newCompletions: 1 } };

      let row = calculateNewTimestamps(timestamps, clean, now, logger)[0];
      expect(row.consecutiveBlocks).toEqual(2);

      timestamps.set('gamer', {
        lastExaminedTimestamp: row.lastExaminedTimestamp,
        blockUntilTimestamp: row.blockUntilTimestamp ?? 0,
        fadeWindowStart: row.fadeWindowStart ?? 0,
        consecutiveBlocks: row.consecutiveBlocks,
      });
      row = calculateNewTimestamps(timestamps, clean, now + 300, logger)[0];
      expect(row.consecutiveBlocks).toEqual(1);

      timestamps.set('gamer', {
        lastExaminedTimestamp: row.lastExaminedTimestamp,
        blockUntilTimestamp: row.blockUntilTimestamp ?? 0,
        fadeWindowStart: row.fadeWindowStart ?? 0,
        consecutiveBlocks: row.consecutiveBlocks,
      });
      row = calculateNewTimestamps(timestamps, clean, now + 600, logger)[0];
      expect(row.consecutiveBlocks).toEqual(0);
    });

    it('processes a mix of fillers in one pass', () => {
      const timestamps: FillerTimestamps = new Map([
        [
          'blocked',
          {
            lastExaminedTimestamp: now - 100,
            blockUntilTimestamp: now + 500,
            fadeWindowStart: now + 500,
            consecutiveBlocks: 1,
          },
        ],
      ]);
      const stats: FillerFadeStatsMap = {
        breach: { fadeRate: 0.25, duringBlockRate: 0.05, newCompletions: 1 },
        clean: { fadeRate: 0.03, duringBlockRate: 0.05, newCompletions: 1 },
        blocked: { fadeRate: 0.05, duringBlockRate: 0.05, newCompletions: 1 },
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
        [
          'extendMe',
          {
            lastExaminedTimestamp: now - 100,
            blockUntilTimestamp: now + 500,
            fadeWindowStart: now + 500,
            consecutiveBlocks: 1,
          },
        ],
      ]);
      const stats: FillerFadeStatsMap = {
        breach: { fadeRate: 0.25, duringBlockRate: 0.05, newCompletions: 1 }, // trips a new block
        clean: { fadeRate: 0.03, duringBlockRate: 0.05, newCompletions: 1 }, // decays
        extendMe: { fadeRate: 0.05, duringBlockRate: 0.2, newCompletions: 1 }, // extends an active block
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
          { lastExaminedTimestamp: now - 100, blockUntilTimestamp: 0, fadeWindowStart: now - 50, consecutiveBlocks: 1 },
        ],
      ]);
      const stats: FillerFadeStatsMap = {
        recovering: { fadeRate: 0.03, duringBlockRate: 0.05, newCompletions: 5 }, // clean run, decays 1 -> 0
      };
      calculateNewTimestamps(timestamps, stats, now, logger, metrics);

      // the step down to 0 is emitted (previousBlocks was 1), not silently dropped
      expect(metrics.putMetric).toHaveBeenCalledWith(
        metricContext(Metric.CIRCUIT_BREAKER_V2_CONSECUTIVE_BLOCKS, 'recovering'),
        0,
        expect.anything()
      );
    });
  });

  describe('fadedOrderHashes persistence', () => {
    it('collects the faded order hashes per cohort in getFillersFadeStats', () => {
      const addr = '0x0000000000000000000000000000000000000001';
      const map = new Map([[addr, 'filler']]);
      // fadeWindowStart in the past: rows after it are the rate window,
      // rows on/before it (but after lastExamined) are the during-block cohort
      const timestamps: FillerTimestamps = new Map([
        [
          'filler',
          { lastExaminedTimestamp: now - 100, blockUntilTimestamp: 0, fadeWindowStart: now - 50, consecutiveBlocks: 0 },
        ],
      ]);
      const rows = [
        order(addr, 1, now - 10, '0xwindowfade'), // window cohort, faded
        order(addr, 0, now - 20, '0xwindowclean'), // window cohort, clean
        order(addr, 1, now - 60, '0xblockfade'), // during-block cohort, faded
        order(addr, 0, now - 70, '0xblockclean'), // during-block cohort, clean
      ];
      const stats = getFillersFadeStats(rows, map, timestamps, logger);
      expect(stats['filler'].windowFadedOrderHashes).toEqual(['0xwindowfade']);
      expect(stats['filler'].duringBlockFadedOrderHashes).toEqual(['0xblockfade']);
    });

    it('stores the window cohort hashes when the fade rate trips a new block', () => {
      const timestamps: FillerTimestamps = new Map();
      const stats: FillerFadeStatsMap = {
        newBad: {
          fadeRate: 0.2,
          duringBlockRate: 0.05,
          newCompletions: 1,
          windowFadedOrderHashes: ['0xw1', '0xw2'],
          duringBlockFadedOrderHashes: ['0xb1'], // under threshold: not a cause
        },
      };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.fadedOrderHashes).toEqual(['0xw1', '0xw2']);
    });

    it('stores the during-block cohort hashes when a late in-flight fade re-blocks after expiry', () => {
      const timestamps: FillerTimestamps = new Map([
        [
          'slip',
          { lastExaminedTimestamp: now - 100, blockUntilTimestamp: 0, fadeWindowStart: now - 10, consecutiveBlocks: 1 },
        ],
      ]);
      const stats: FillerFadeStatsMap = {
        slip: {
          fadeRate: 0.05, // clean since the block ended
          duringBlockRate: 0.3,
          newCompletions: 1,
          windowFadedOrderHashes: [],
          duringBlockFadedOrderHashes: ['0xinflight'],
        },
      };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toBeGreaterThan(now);
      expect(row.fadedOrderHashes).toEqual(['0xinflight']);
    });

    it('appends the extending in-flight fades to the stored hashes when extending a block', () => {
      const timestamps: FillerTimestamps = new Map([
        [
          'blocked',
          {
            lastExaminedTimestamp: now - 100,
            blockUntilTimestamp: now + 500,
            fadeWindowStart: now + 500,
            consecutiveBlocks: 1,
            fadedOrderHashes: ['0xold'],
          },
        ],
      ]);
      const stats: FillerFadeStatsMap = {
        blocked: {
          fadeRate: 0.05,
          duringBlockRate: 0.3,
          newCompletions: 1,
          windowFadedOrderHashes: [],
          duringBlockFadedOrderHashes: ['0xnew'],
        },
      };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toBeGreaterThan(now + 500);
      expect(row.fadedOrderHashes).toEqual(['0xold', '0xnew']);
    });

    it('carries stored hashes forward when blocked with a clean in-flight cohort', () => {
      const timestamps: FillerTimestamps = new Map([
        [
          'blocked',
          {
            lastExaminedTimestamp: now - 100,
            blockUntilTimestamp: now + 500,
            fadeWindowStart: now + 500,
            consecutiveBlocks: 1,
            fadedOrderHashes: ['0xold'],
          },
        ],
      ]);
      const stats: FillerFadeStatsMap = {
        blocked: { fadeRate: 0.05, duringBlockRate: 0.05, newCompletions: 1 },
      };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(now + 500);
      expect(row.fadedOrderHashes).toEqual(['0xold']);
    });

    it('clears stored hashes when the filler is under threshold (block expired)', () => {
      const timestamps: FillerTimestamps = new Map([
        [
          'recovered',
          {
            lastExaminedTimestamp: now - 100,
            blockUntilTimestamp: 0,
            fadeWindowStart: now - 50,
            consecutiveBlocks: 1,
            fadedOrderHashes: ['0xold'],
          },
        ],
      ]);
      const stats: FillerFadeStatsMap = {
        recovered: { fadeRate: 0.05, duringBlockRate: 0.05, newCompletions: 1 },
      };
      const [row] = calculateNewTimestamps(timestamps, stats, now, logger);
      expect(row.blockUntilTimestamp).toEqual(UNBLOCKED_BLOCK_UNTIL_TIMESTAMP);
      expect(row.fadedOrderHashes).toBeUndefined();
    });

    it('dedupes and caps stored hashes at MAX_FADED_ORDER_HASHES, keeping the most recent', () => {
      const existing = Array.from({ length: MAX_FADED_ORDER_HASHES }, (_, i) => `0x${i}`);
      const timestamps: FillerTimestamps = new Map([
        [
          'blocked',
          {
            lastExaminedTimestamp: now - 100,
            blockUntilTimestamp: now + 500,
            fadeWindowStart: now + 500,
            consecutiveBlocks: 1,
            fadedOrderHashes: existing,
          },
        ],
      ]);
      const stats: FillerFadeStatsMap = {
        blocked: {
          fadeRate: 0.05,
          duringBlockRate: 0.3,
          newCompletions: 1,
          duringBlockFadedOrderHashes: ['0x1', '0xnew'], // '0x1' is already stored
        },
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
        [
          'benchedIdle',
          {
            lastExaminedTimestamp: now - 100,
            blockUntilTimestamp: now + 500,
            fadeWindowStart: now + 500,
            consecutiveBlocks: 1,
          },
        ],
        // recovered: past block, no update
        [
          'recovered',
          { lastExaminedTimestamp: now - 100, blockUntilTimestamp: 0, fadeWindowStart: now - 50, consecutiveBlocks: 0 },
        ],
        // stored state says unblocked, but this run blocks them
        [
          'justBlocked',
          { lastExaminedTimestamp: now - 100, blockUntilTimestamp: 0, fadeWindowStart: now - 50, consecutiveBlocks: 0 },
        ],
      ]);
      const updated: ToUpdateTimestampRow[] = [
        {
          hash: 'justBlocked',
          lastExaminedTimestamp: now,
          blockUntilTimestamp: now + 900,
          fadeWindowStart: now + 900,
          consecutiveBlocks: 1,
        },
        {
          hash: 'newClean',
          lastExaminedTimestamp: now,
          blockUntilTimestamp: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
          fadeWindowStart: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
          consecutiveBlocks: 0,
        },
      ];
      expect(countActiveBlocks(timestamps, updated, now)).toEqual(2); // benchedIdle + justBlocked
    });

    it('treats an unset (0 / undefined) blockUntilTimestamp as unblocked', () => {
      const timestamps: FillerTimestamps = new Map([
        ['unsetRow', { lastExaminedTimestamp: 1, blockUntilTimestamp: 0, fadeWindowStart: 0, consecutiveBlocks: 0 }],
      ]);
      const updated: ToUpdateTimestampRow[] = [
        { hash: 'undefRow', lastExaminedTimestamp: now, blockUntilTimestamp: undefined, consecutiveBlocks: 0 },
      ];
      expect(countActiveBlocks(timestamps, updated, now)).toEqual(0);
    });
  });
});
