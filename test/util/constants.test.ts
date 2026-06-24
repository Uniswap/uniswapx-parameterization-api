import {
  getV3BlockBuffer,
  getWebhookTimeoutMs,
} from '../../lib/constants';
import { ChainId } from '../../lib/util/chains';

describe('V3 chain constants', () => {
  describe('getV3BlockBuffer', () => {
    it('mainnet: ceil(5/12) = 1', () => {
      expect(getV3BlockBuffer(ChainId.MAINNET)).toEqual(1);
    });
    it('arbitrum: ceil(5/0.25) = 20', () => {
      expect(getV3BlockBuffer(ChainId.ARBITRUM_ONE)).toEqual(20);
    });
    it('tempo: ceil(5/0.5) = 10', () => {
      expect(getV3BlockBuffer(ChainId.TEMPO)).toEqual(10);
    });
    it('arc: ceil(5/0.48) = 11', () => {
      expect(getV3BlockBuffer(ChainId.ARC)).toEqual(11);
    });
    it('robinhood: ceil(5/0.1) = 50', () => {
      expect(getV3BlockBuffer(ChainId.ROBINHOOD)).toEqual(50);
    });
    it('throws on unknown chainId (propagated from sdk-core)', () => {
      expect(() => getV3BlockBuffer(99999)).toThrow(/unsupported chainId 99999/);
    });
  });

  describe('getWebhookTimeoutMs', () => {
    it('keeps mainnet at 500 ms', () => {
      expect(getWebhookTimeoutMs(ChainId.MAINNET)).toEqual(500);
    });
    it('uses 500 ms on arbitrum', () => {
      expect(getWebhookTimeoutMs(ChainId.ARBITRUM_ONE)).toEqual(500);
    });
    it('uses 500 ms on tempo', () => {
      expect(getWebhookTimeoutMs(ChainId.TEMPO)).toEqual(500);
    });
    it('uses 500 ms on base', () => {
      expect(getWebhookTimeoutMs(ChainId.BASE)).toEqual(500);
    });
    it('defaults to 500 ms for unknown chains', () => {
      expect(getWebhookTimeoutMs(99999)).toEqual(500);
    });
  });
});
