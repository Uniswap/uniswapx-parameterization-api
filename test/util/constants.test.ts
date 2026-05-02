import {
  V3_DEFAULT_DECAY_DURATION_SECS,
  getBlockTimeSecs,
  getDecayBlockLength,
  getV3BlockBuffer,
} from '../../lib/constants';
import { ChainId } from '../../lib/util/chains';

describe('V3 chain constants', () => {
  describe('getBlockTimeSecs', () => {
    it('returns 12s for mainnet', () => {
      expect(getBlockTimeSecs(ChainId.MAINNET)).toEqual(12);
    });
    it('returns 0.25s for arbitrum', () => {
      expect(getBlockTimeSecs(ChainId.ARBITRUM_ONE)).toEqual(0.25);
    });
    it('returns 0.5s for tempo', () => {
      expect(getBlockTimeSecs(ChainId.TEMPO)).toEqual(0.5);
    });
    it('defaults to 12s for unknown chains', () => {
      expect(getBlockTimeSecs(99999)).toEqual(12);
    });
  });

  describe('getDecayBlockLength', () => {
    it(`uses ${V3_DEFAULT_DECAY_DURATION_SECS}s as the V3 decay duration default`, () => {
      expect(V3_DEFAULT_DECAY_DURATION_SECS).toEqual(30);
    });
    it('mainnet: ceil(30/12) = 3', () => {
      expect(getDecayBlockLength(ChainId.MAINNET)).toEqual(3);
    });
    it('arbitrum: ceil(30/0.25) = 120', () => {
      expect(getDecayBlockLength(ChainId.ARBITRUM_ONE)).toEqual(120);
    });
    it('tempo: ceil(30/0.5) = 60', () => {
      expect(getDecayBlockLength(ChainId.TEMPO)).toEqual(60);
    });
  });

  describe('getV3BlockBuffer', () => {
    it('preserves scalar 4 for mainnet', () => {
      expect(getV3BlockBuffer(ChainId.MAINNET)).toEqual(4);
    });
    it('preserves scalar 4 for arbitrum', () => {
      expect(getV3BlockBuffer(ChainId.ARBITRUM_ONE)).toEqual(4);
    });
    it('uses 1 for tempo', () => {
      expect(getV3BlockBuffer(ChainId.TEMPO)).toEqual(1);
    });
    it('defaults to 4 for unknown chains', () => {
      expect(getV3BlockBuffer(99999)).toEqual(4);
    });
  });
});
