import Logger from 'bunyan';

import {
  BASE_BLOCK_SECS,
  calculateNewTimestamps,
  FillerFades,
  FillerTimestamps,
  getFillersNewFades,
  NUM_FADES_MULTIPLIER,
} from '../../lib/cron/fade-rate-v2';
import { ToUpdateTimestampRow, V2FadesRowType } from '../../lib/repositories';

const now = Math.floor(Date.now() / 1000);

const FADES_ROWS: V2FadesRowType[] = [
  // filler1
  { fillerAddress: '0x0000000000000000000000000000000000000001', faded: 1, postTimestamp: now - 100 },
  { fillerAddress: '0x0000000000000000000000000000000000000001', faded: 0, postTimestamp: now - 90 },
  { fillerAddress: '0x0000000000000000000000000000000000000001', faded: 1, postTimestamp: now - 80 },
  { fillerAddress: '0x0000000000000000000000000000000000000002', faded: 1, postTimestamp: now - 80 },
  // filler2
  { fillerAddress: '0x0000000000000000000000000000000000000003', faded: 1, postTimestamp: now - 70 },
  { fillerAddress: '0x0000000000000000000000000000000000000003', faded: 1, postTimestamp: now - 100 },
  // filler3
  { fillerAddress: '0x0000000000000000000000000000000000000004', faded: 1, postTimestamp: now - 100 },
  // filler4
  { fillerAddress: '0x0000000000000000000000000000000000000005', faded: 0, postTimestamp: now - 100 },
  // filler5
  { fillerAddress: '0x0000000000000000000000000000000000000006', faded: 0, postTimestamp: now - 100 },
  // filler6
  { fillerAddress: '0x0000000000000000000000000000000000000007', faded: 1, postTimestamp: now - 100 },
  // filler7
  { fillerAddress: '0x0000000000000000000000000000000000000008', faded: 1, postTimestamp: now - 100 },
  // filler8
  { fillerAddress: '0x0000000000000000000000000000000000000009', faded: 0, postTimestamp: now - 100 },
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
          // test exponential backoff
          {
            hash: 'filler7',
            lastPostTimestamp: now,
            blockUntilTimestamp: now + Math.floor(BASE_BLOCK_SECS * Math.pow(NUM_FADES_MULTIPLIER, 0) * Math.pow(2, 2)),
            consecutiveBlocks: 3,
          },
          // test consecutiveBlocks reset
          // does not really block filler, as blockUntilTimestamp is not in the future
          {
            hash: 'filler8',
            lastPostTimestamp: now,
            blockUntilTimestamp: now,
            consecutiveBlocks: 0,
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
      expect(newTimestamps).not.toContain([['filler5', expect.anything(), expect.anything()]]);
      expect(newTimestamps).not.toContain([['filler4', expect.anything(), expect.anything()]]);
    });

    it('ignores fillers with blockUntilTimestamp > current timestamp', () => {
      expect(newTimestamps).not.toContain([['filler3', expect.anything(), expect.anything()]]);
    });
  });
});
