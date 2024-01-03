import Logger from 'bunyan';

import {
  BLOCK_PER_FADE_SECS,
  calculateNewTimestamps,
  FillerFades,
  FillerTimestamps,
  getFillersNewFades,
} from '../../lib/cron/fade-rate';
import { FadesRowType } from '../../lib/repositories';

const now = Math.floor(Date.now() / 1000);

const FADES_ROWS: FadesRowType[] = [
  // filler1
  { fillerAddress: '0x1', faded: 1, postTimestamp: now - 100 },
  { fillerAddress: '0x1', faded: 0, postTimestamp: now - 90 },
  { fillerAddress: '0x1', faded: 1, postTimestamp: now - 80 },
  { fillerAddress: '0x2', faded: 1, postTimestamp: now - 80 },
  // filler2
  { fillerAddress: '0x3', faded: 1, postTimestamp: now - 70 },
  { fillerAddress: '0x3', faded: 1, postTimestamp: now - 100 },
  // filler3
  { fillerAddress: '0x4', faded: 1, postTimestamp: now - 100 },
];

const ADDRESS_TO_FILLER = new Map<string, string>([
  ['0x1', 'filler1'],
  ['0x2', 'filler1'],
  ['0x3', 'filler2'],
  ['0x4', 'filler3'],
]);

const FILLER_TIMESTAMPS: FillerTimestamps = new Map([
  ['filler1', { lastPostTimestamp: now - 150, blockUntilTimestamp: NaN }],
  ['filler2', { lastPostTimestamp: now - 75, blockUntilTimestamp: now - 50 }],
  ['filler3', { lastPostTimestamp: now - 101, blockUntilTimestamp: now + 1000 }],
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
      });
    });
  });

  describe('calculateNewTimestamps', () => {
    let newTimestamps: [string, number, number?][];

    beforeAll(() => {
      newTimestamps = calculateNewTimestamps(FILLER_TIMESTAMPS, newFades, now, logger);
    });

    it('calculates blockUntilTimestamp for each filler', () => {
      expect(newTimestamps).toMatchObject([
        ['filler1', now, now + BLOCK_PER_FADE_SECS * 3],
        ['filler2', now, now + BLOCK_PER_FADE_SECS * 1],
      ]);
    });

    it('ignores fillers with blockUntilTimestamp > current timestamp', () => {
      expect(newTimestamps).toHaveLength(2);
      expect(newTimestamps).not.toMatchObject([['filler3', expect.anything(), expect.anything()]]);
    });
  });
});
