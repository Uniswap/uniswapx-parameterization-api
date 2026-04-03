import Logger from 'bunyan';

import {
  BASE_BLOCK_SECS,
  calculateNewTimestamps,
  FillerFades,
  FillerTimestamps,
  getFillersNewFades,
  NUM_FADES_MULTIPLIER,
  UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
} from '../../lib/cron/fade-rate-v2';
import { ToUpdateTimestampRow, V2FadesRowType } from '../../lib/repositories';

const now = Math.floor(Date.now() / 1000);

// Note: deadline = postTimestamp + 20 (simulating 20-second order lifetime)
// Orders are counted as "new" if deadline > lastPostTimestamp (not postTimestamp!)
const FADES_ROWS: V2FadesRowType[] = [
  // filler1 - lastPostTimestamp: now - 150, all orders have deadline > now - 150, so all counted
  {
    fillerAddress: '0x0000000000000000000000000000000000000001',
    faded: 1,
    postTimestamp: now - 100,
    deadline: now - 80,
  },
  {
    fillerAddress: '0x0000000000000000000000000000000000000001',
    faded: 0,
    postTimestamp: now - 90,
    deadline: now - 70,
  },
  {
    fillerAddress: '0x0000000000000000000000000000000000000001',
    faded: 1,
    postTimestamp: now - 80,
    deadline: now - 60,
  },
  {
    fillerAddress: '0x0000000000000000000000000000000000000002',
    faded: 1,
    postTimestamp: now - 80,
    deadline: now - 60,
  },
  // filler2 - lastPostTimestamp: now - 75
  // Order at now - 100 has deadline now - 80 which is NOT > now - 75, so NOT counted
  // Order at now - 70 has deadline now - 50 which IS > now - 75, so counted
  {
    fillerAddress: '0x0000000000000000000000000000000000000003',
    faded: 1,
    postTimestamp: now - 70,
    deadline: now - 50,
  },
  {
    fillerAddress: '0x0000000000000000000000000000000000000003',
    faded: 1,
    postTimestamp: now - 100,
    deadline: now - 80,
  },
  // filler3 - lastPostTimestamp: now - 101, deadline now - 80 > now - 101, so counted
  // filler3 is BLOCKED (blockUntilTimestamp: now + 1000) and has a fade!
  {
    fillerAddress: '0x0000000000000000000000000000000000000004',
    faded: 1,
    postTimestamp: now - 100,
    deadline: now - 80,
  },
  // filler4 - lastPostTimestamp: now - 150, deadline now - 80 > now - 150, so counted
  {
    fillerAddress: '0x0000000000000000000000000000000000000005',
    faded: 0,
    postTimestamp: now - 100,
    deadline: now - 80,
  },
  // filler5 - lastPostTimestamp: now - 150, deadline now - 80 > now - 150, so counted
  // filler5 is BLOCKED (blockUntilTimestamp: now + 100) but has NO fade
  {
    fillerAddress: '0x0000000000000000000000000000000000000006',
    faded: 0,
    postTimestamp: now - 100,
    deadline: now - 80,
  },
  // filler6 - not in FILLER_TIMESTAMPS, so all counted
  {
    fillerAddress: '0x0000000000000000000000000000000000000007',
    faded: 1,
    postTimestamp: now - 100,
    deadline: now - 80,
  },
  // filler7 - lastPostTimestamp: now - 150, deadline now - 80 > now - 150, so counted
  {
    fillerAddress: '0x0000000000000000000000000000000000000008',
    faded: 1,
    postTimestamp: now - 100,
    deadline: now - 80,
  },
  // filler8 - lastPostTimestamp: now - 150, deadline now - 80 > now - 150, so counted
  {
    fillerAddress: '0x0000000000000000000000000000000000000009',
    faded: 0,
    postTimestamp: now - 100,
    deadline: now - 80,
  },
];

const ADDRESS_TO_FILLER = new Map<string, string>([
  ['0x0000000000000000000000000000000000000001', 'filler1'],
  ['0x0000000000000000000000000000000000000002', 'filler1'],
  ['0x0000000000000000000000000000000000000003', 'filler2'],
  ['0x0000000000000000000000000000000000000004', 'filler3'],
  ['0x0000000000000000000000000000000000000005', 'filler4'],
  ['0x0000000000000000000000000000000000000006', 'filler5'],
  ['0x0000000000000000000000000000000000000007', 'filler6'],
  ['0x0000000000000000000000000000000000000008', 'filler7'],
  ['0x0000000000000000000000000000000000000009', 'filler8'],
]);

const FILLER_TIMESTAMPS: FillerTimestamps = new Map([
  ['filler1', { lastPostTimestamp: now - 150, blockUntilTimestamp: NaN, consecutiveBlocks: NaN }],
  ['filler2', { lastPostTimestamp: now - 75, blockUntilTimestamp: now - 50, consecutiveBlocks: 0 }],
  ['filler3', { lastPostTimestamp: now - 101, blockUntilTimestamp: now + 1000, consecutiveBlocks: 0 }],
  ['filler4', { lastPostTimestamp: now - 150, blockUntilTimestamp: NaN, consecutiveBlocks: 0 }],
  ['filler5', { lastPostTimestamp: now - 150, blockUntilTimestamp: now + 100, consecutiveBlocks: 0 }],
  ['filler7', { lastPostTimestamp: now - 150, blockUntilTimestamp: now - 50, consecutiveBlocks: 2 }],
  ['filler8', { lastPostTimestamp: now - 150, blockUntilTimestamp: now - 50, consecutiveBlocks: 2 }],
]);

// silent logger in tests
const logger = Logger.createLogger({ name: 'test' });
logger.level(Logger.FATAL);

describe('FadeRateCron test', () => {
  let newFades: FillerFades;
  beforeAll(() => {
    newFades = getFillersNewFades(FADES_ROWS, ADDRESS_TO_FILLER, FILLER_TIMESTAMPS, logger);
  });

  describe('getFillersNewFades', () => {
    it('takes into account multiple filler addresses of the same filler', () => {
      expect(newFades).toEqual({
        filler1: 3, // count all fades in FADES_ROWS
        filler2: 1, // only count postTimestamp == now - 70
        filler3: 1,
        filler4: 0,
        filler5: 0,
        filler6: 1,
        filler7: 1,
        filler8: 0,
      });
    });
  });

  describe('calculateNewTimestamps', () => {
    let newTimestamps: ToUpdateTimestampRow[];

    beforeAll(() => {
      newTimestamps = calculateNewTimestamps(FILLER_TIMESTAMPS, newFades, now, logger);
    });

    it('calculates blockUntilTimestamp for each filler', () => {
      expect(newTimestamps).toEqual(
        expect.arrayContaining([
          {
            hash: 'filler1',
            lastPostTimestamp: now,
            blockUntilTimestamp: now + Math.floor(BASE_BLOCK_SECS * Math.pow(NUM_FADES_MULTIPLIER, 2)),
            consecutiveBlocks: 1,
          },
          {
            hash: 'filler2',
            lastPostTimestamp: now,
            blockUntilTimestamp: now + Math.floor(BASE_BLOCK_SECS * Math.pow(NUM_FADES_MULTIPLIER, 0)),
            consecutiveBlocks: 1,
          },
          // filler3 is blocked AND has a fade → EXTEND block from current blockUntil
          // Block extended from (now + 1000) by BASE_BLOCK_SECS * 1.2^0 * 2^0 = 15 min
          {
            hash: 'filler3',
            lastPostTimestamp: now,
            blockUntilTimestamp: now + 1000 + Math.floor(BASE_BLOCK_SECS * Math.pow(NUM_FADES_MULTIPLIER, 0)),
            consecutiveBlocks: 1, // incremented from 0
          },
          // filler5 is blocked but has NO fade → keeps existing block
          {
            hash: 'filler5',
            lastPostTimestamp: now,
            blockUntilTimestamp: now + 100,
            consecutiveBlocks: 0,
          },
          // test exponential backoff
          {
            hash: 'filler7',
            lastPostTimestamp: now,
            blockUntilTimestamp: now + Math.floor(BASE_BLOCK_SECS * Math.pow(NUM_FADES_MULTIPLIER, 0) * Math.pow(2, 2)),
            consecutiveBlocks: 3,
          },
          // consecutiveBlocks DECAY instead of reset
          // filler8 had consecutiveBlocks: 2, no fades → decays to 1
          {
            hash: 'filler8',
            lastPostTimestamp: now,
            blockUntilTimestamp: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
            consecutiveBlocks: 1, // decayed from 2, not reset to 0
          },
        ])
      );
    });

    it('notices new fillers not already in fillerTimestamps', () => {
      // filler6 one fade, no existing consecutiveBlocks
      expect(newTimestamps).toEqual(
        expect.arrayContaining([
          {
            hash: 'filler6',
            lastPostTimestamp: now,
            blockUntilTimestamp: now + Math.floor(BASE_BLOCK_SECS * Math.pow(NUM_FADES_MULTIPLIER, 0)),
            consecutiveBlocks: 1,
          },
        ])
      );
    });

    it('keep old blockUntilTimestamp if no new fades', () => {
      expect(newTimestamps).not.toContain([['filler4', expect.anything(), expect.anything()]]);
    });

    it('decays consecutiveBlocks instead of resetting to 0', () => {
      // filler8 had consecutiveBlocks: 2 and no new fades
      // decay to 1
      const filler8 = newTimestamps.find((t) => t.hash === 'filler8');
      expect(filler8?.consecutiveBlocks).toBe(1); // decayed, not reset
    });

    it('extends block when filler fades while blocked', () => {
      // filler3 was blocked until now + 1000, and had 1 fade
      // extend to now + 1000 + penalty
      const filler3 = newTimestamps.find((t) => t.hash === 'filler3');
      expect(filler3?.blockUntilTimestamp).toBeGreaterThan(now + 1000);
      expect(filler3?.consecutiveBlocks).toBe(1); // incremented from 0
    });

    it('keeps block but does not decay when blocked with no fades', () => {
      // filler5 was blocked until now + 100, and had 0 fades
      // Should keep existing block without decaying consecutiveBlocks
      const filler5 = newTimestamps.find((t) => t.hash === 'filler5');
      expect(filler5?.blockUntilTimestamp).toBe(now + 100);
      expect(filler5?.consecutiveBlocks).toBe(0); // unchanged, not decayed
    });
  });

  describe('Alternating fade/clean cycle gaming', () => {
    it('requires multiple clean cycles to fully reset consecutiveBlocks', () => {
      // Simulate: Filler built up consecutiveBlocks: 3, now has a clean cycle
      const timestamps: FillerTimestamps = new Map([
        ['gamer', { lastPostTimestamp: now - 100, blockUntilTimestamp: now - 50, consecutiveBlocks: 3 }],
      ]);

      // Cycle 1: Clean (no fades)
      let result = calculateNewTimestamps(timestamps, { gamer: 0 }, now, logger);
      expect(result[0].consecutiveBlocks).toBe(2); // 3 → 2

      // Cycle 2: Clean again
      timestamps.set('gamer', {
        lastPostTimestamp: result[0].lastPostTimestamp,
        blockUntilTimestamp: result[0].blockUntilTimestamp ?? now + 300,
        consecutiveBlocks: result[0].consecutiveBlocks,
      });
      result = calculateNewTimestamps(timestamps, { gamer: 0 }, now + 300, logger);
      expect(result[0].consecutiveBlocks).toBe(1); // 2 → 1

      // Cycle 3: Clean again
      timestamps.set('gamer', {
        lastPostTimestamp: result[0].lastPostTimestamp,
        blockUntilTimestamp: result[0].blockUntilTimestamp ?? now + 600,
        consecutiveBlocks: result[0].consecutiveBlocks,
      });
      result = calculateNewTimestamps(timestamps, { gamer: 0 }, now + 600, logger);
      expect(result[0].consecutiveBlocks).toBe(0); // 1 → 0

      // Takes 3 clean cycles, not 1!
    });

    it('escalates penalty when filler fades after only partial decay', () => {
      // Simulate: Filler has consecutiveBlocks: 2, does 1 clean cycle, then fades again
      const timestamps: FillerTimestamps = new Map([
        ['gamer', { lastPostTimestamp: now - 100, blockUntilTimestamp: now - 50, consecutiveBlocks: 2 }],
      ]);

      // Cycle 1: Clean - decays from 2 to 1
      let result = calculateNewTimestamps(timestamps, { gamer: 0 }, now, logger);
      expect(result[0].consecutiveBlocks).toBe(1);

      // Cycle 2: Fades again! consecutiveBlocks goes from 1 to 2
      timestamps.set('gamer', {
        lastPostTimestamp: now,
        blockUntilTimestamp: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP, // block expired
        consecutiveBlocks: 1,
      });
      result = calculateNewTimestamps(timestamps, { gamer: 1 }, now + 300, logger);
      expect(result[0].consecutiveBlocks).toBe(2); // back up!

      // Penalty should be: BASE_BLOCK_SECS * 1.2^0 * 2^1 = 30 minutes
      const expectedBlock = now + 300 + Math.floor(BASE_BLOCK_SECS * Math.pow(2, 1));
      expect(result[0].blockUntilTimestamp).toBe(expectedBlock);
    });

    it('OLD EXPLOIT: would have allowed indefinite 15-min penalties', () => {
      // This test documents what the OLD behavior would have allowed:
      // Filler fades, gets blocked 15 min, waits, does 1 clean cycle, fades again
      // Result: Always gets minimum 15-min penalty, never escalates

      // With NEW behavior, even alternating pattern eventually accumulates
      const timestamps: FillerTimestamps = new Map([
        ['attacker', { lastPostTimestamp: now - 100, blockUntilTimestamp: now - 50, consecutiveBlocks: 0 }],
      ]);

      // Pattern: fade, clean, fade, clean, fade...
      // Cycle 1: Fade
      let result = calculateNewTimestamps(timestamps, { attacker: 1 }, now, logger);
      expect(result[0].consecutiveBlocks).toBe(1);
      const block1 = result[0].blockUntilTimestamp! - now; // ~15 min

      // Cycle 2: Clean (after block expires)
      timestamps.set('attacker', {
        lastPostTimestamp: now,
        blockUntilTimestamp: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
        consecutiveBlocks: 1,
      });
      result = calculateNewTimestamps(timestamps, { attacker: 0 }, now + 1000, logger);
      expect(result[0].consecutiveBlocks).toBe(0); // decayed to 0

      // Cycle 3: Fade again
      timestamps.set('attacker', {
        lastPostTimestamp: now + 1000,
        blockUntilTimestamp: UNBLOCKED_BLOCK_UNTIL_TIMESTAMP,
        consecutiveBlocks: 0,
      });
      result = calculateNewTimestamps(timestamps, { attacker: 1 }, now + 2000, logger);
      expect(result[0].consecutiveBlocks).toBe(1);
      const block3 = result[0].blockUntilTimestamp! - (now + 2000);

      // Both penalties are the same (15 min) - this is still possible with alternating
      // But at least they can't game it with a SINGLE clean cycle after building up blocks
      expect(block1).toBe(block3);
    });
  });

  /**
   * EXPLOIT #2 PREVENTION TESTS
   *
   * Attack vector: Orders assigned before a block can fade during the block period,
   * but those fades weren't being counted due to postTimestamp comparison.
   * Also: Fading while blocked didn't extend the block or increment consecutiveBlocks.
   *
   * Old behavior: Fades during block were ignored
   * New behavior: Block is extended and consecutiveBlocks incremented
   */
  describe('Exploit #2 Prevention: Fading while blocked', () => {
    it('extends block when filler fades during existing block', () => {
      const timestamps: FillerTimestamps = new Map([
        ['blocked', { lastPostTimestamp: now - 100, blockUntilTimestamp: now + 500, consecutiveBlocks: 1 }],
      ]);

      // Filler is blocked until now + 500, but has 2 fades from pre-block orders
      const result = calculateNewTimestamps(timestamps, { blocked: 2 }, now, logger);
      const blocked = result[0];

      // Block should be EXTENDED from now + 500, not kept as-is
      expect(blocked.blockUntilTimestamp).toBeGreaterThan(now + 500);

      // consecutiveBlocks should increment
      expect(blocked.consecutiveBlocks).toBe(2);

      // Verify the extension amount: BASE_BLOCK_SECS * 1.2^(2-1) * 2^1
      const expectedExtension = Math.floor(BASE_BLOCK_SECS * Math.pow(NUM_FADES_MULTIPLIER, 1) * Math.pow(2, 1));
      expect(blocked.blockUntilTimestamp).toBe(now + 500 + expectedExtension);
    });

    it('counts orders by deadline, not postTimestamp (in-flight order fix)', () => {
      // Scenario: Order posted at T=-100, deadline at T=-50
      // lastPostTimestamp was T=-60 (set by previous cron run)
      //
      // OLD: postTimestamp (-100) > lastPostTimestamp (-60)? NO → not counted
      // NEW: deadline (-50) > lastPostTimestamp (-60)? YES → counted

      const timestamps: FillerTimestamps = new Map([
        ['filler', { lastPostTimestamp: now - 60, blockUntilTimestamp: now - 100, consecutiveBlocks: 0 }],
      ]);
      const addressMap = new Map([['0x0000000000000000000000000000000000000001', 'filler']]);

      // Order posted before lastPostTimestamp, but deadline after
      const rows: V2FadesRowType[] = [
        {
          fillerAddress: '0x0000000000000000000000000000000000000001',
          faded: 1,
          postTimestamp: now - 100, // Before lastPostTimestamp
          deadline: now - 50, // After lastPostTimestamp
        },
      ];

      const fades = getFillersNewFades(rows, addressMap, timestamps, logger);

      // With deadline-based check, this fade IS counted
      expect(fades['filler']).toBe(1);
    });

    it('OLD EXPLOIT: fading while blocked had no consequences', () => {
      // Document what OLD behavior would have done
      const timestamps: FillerTimestamps = new Map([
        ['badActor', { lastPostTimestamp: now - 100, blockUntilTimestamp: now + 1000, consecutiveBlocks: 2 }],
      ]);

      // With OLD behavior, this would have kept blockUntilTimestamp at now + 1000
      // and consecutiveBlocks at 2 (no change)

      // With NEW behavior:
      const result = calculateNewTimestamps(timestamps, { badActor: 3 }, now, logger);

      // Block is extended significantly
      expect(result[0].blockUntilTimestamp).toBeGreaterThan(now + 1000);

      // consecutiveBlocks increased
      expect(result[0].consecutiveBlocks).toBe(3);
    });

    it('does not decay consecutiveBlocks while actively blocked', () => {
      // If blocked with no new fades, should keep consecutiveBlocks (not decay)
      const timestamps: FillerTimestamps = new Map([
        ['blocked', { lastPostTimestamp: now - 100, blockUntilTimestamp: now + 500, consecutiveBlocks: 3 }],
      ]);

      const result = calculateNewTimestamps(timestamps, { blocked: 0 }, now, logger);

      // No decay while blocked - they're serving their time
      expect(result[0].consecutiveBlocks).toBe(3);
      expect(result[0].blockUntilTimestamp).toBe(now + 500);
    });
  });
});
