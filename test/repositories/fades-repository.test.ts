import { OrderType } from '@uniswap/uniswapx-sdk';

import { V2_FADE_RATE_SQL } from '../../lib/repositories';

describe('V2_FADE_RATE_SQL', () => {
  describe('Dutch_V3 fade predicate', () => {
    // On-chain, a fill AT decayStartBlock (fillTimeBlocks = 0) is still within the
    // exclusive filler's window and pays the full undecayed price; decay and open
    // filling only begin at decayStartBlock + 1.
    it('does not count a fill at the decay start block (fillTimeBlocks = 0) as a fade', () => {
      expect(V2_FADE_RATE_SQL).not.toContain('fillTimeBlocks >= 0');
    });

    it('counts a fill strictly after the decay start block (fillTimeBlocks = 1) as a fade', () => {
      expect(V2_FADE_RATE_SQL).toContain(`WHEN orderType = '${OrderType.Dutch_V3}' AND fillTimeBlocks > 0 THEN 1`);
    });

    it('matches the strict inequality used by the Dutch_V2 rule', () => {
      expect(V2_FADE_RATE_SQL).toContain(
        `WHEN orderType = '${OrderType.Dutch_V2}' AND decayStartTime < fillTimestamp THEN 1`
      );
    });
  });
});
