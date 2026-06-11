import {
  getV3BlockBuffer,
  getWebhookTimeoutMs,
} from '../../lib/constants';
import { ChainId } from '../../lib/util/chains';

describe('V3 chain constants', () => {
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
