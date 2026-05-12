import {
  V3_DEFAULT_DECAY_DURATION_SECS,
  getBlockTimeSecs,
  getDecayBlockLength,
  getV3BlockBuffer,
  getWebhookTimeoutMs,
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
    it('mainnet: ceil(1/12) = 1', () => {
      expect(getV3BlockBuffer(ChainId.MAINNET)).toEqual(1);
    });
    it('arbitrum: ceil(1/0.25) = 4', () => {
      expect(getV3BlockBuffer(ChainId.ARBITRUM_ONE)).toEqual(4);
    });
    it('tempo: ceil(1/0.5) = 2', () => {
      expect(getV3BlockBuffer(ChainId.TEMPO)).toEqual(2);
    });
    it('defaults to ceil(1/12) = 1 for unknown chains', () => {
      expect(getV3BlockBuffer(99999)).toEqual(1);
    });
  });

  describe('getWebhookTimeoutMs', () => {
    it('keeps mainnet at 500 ms', () => {
      expect(getWebhookTimeoutMs(ChainId.MAINNET)).toEqual(500);
    });
    it('tightens arbitrum to 250 ms', () => {
      expect(getWebhookTimeoutMs(ChainId.ARBITRUM_ONE)).toEqual(250);
    });
    it('tightens tempo to 250 ms', () => {
      expect(getWebhookTimeoutMs(ChainId.TEMPO)).toEqual(250);
    });
    it('tightens base to 250 ms', () => {
      expect(getWebhookTimeoutMs(ChainId.BASE)).toEqual(250);
    });
    it('defaults to 250 ms for unknown chains', () => {
      expect(getWebhookTimeoutMs(99999)).toEqual(250);
    });
  });
});
