import { filterResults, ResultRowType, TokenConfig, validateConfigs } from '../../lib/cron/synth-switch';

const EXAMPLE_ROW_RESULT = {
  tokenin: '0xa',
  tokenout: '0xb',
  tokeninchainid: 1,
  tokenoutchainid: 1,
  dutch_amountin: '0',
  dutch_amountout: '0',
  classic_amountin: '0',
  classic_amountout: '0',
  classic_amountingasadjusted: '0',
  classic_amountoutgasadjusted: '0',
  dutch_amountingasadjusted: '0',
  dutch_amountoutgasadjusted: '0',
  filler: '0',
  filltimestamp: '0',
  settledAmountIn: '0',
  settledAmountOut: '0',
};

describe('synth-switch util tests', () => {
  describe('validateConfigs', () => {
    it('filters out bad configs', () => {
      const badAddresses: TokenConfig[] = [
        {
          tokenIn: '0xdead',
          tokenOut: '0xbeef',
          tokenInChainId: 1,
          tokenOutChainId: 1,
          tradeTypes: ['EXACT_INPUT'],
          lowerBound: ['0'],
        },
      ];
      expect(validateConfigs(badAddresses)).toStrictEqual([]);
    });
  });

  describe('filterResults', () => {
    it('filters out rows that do not have matching token pairs in the configs', () => {
      const configs: TokenConfig[] = [
        {
          tokenIn: '0xa',
          tokenOut: '0xb',
          tokenInChainId: 1,
          tokenOutChainId: 1,
          tradeTypes: ['EXACT_INPUT'],
          lowerBound: ['0'],
        },
        {
          tokenIn: '0xc',
          tokenOut: '0xd',
          tokenInChainId: 1,
          tokenOutChainId: 1,
          tradeTypes: ['EXACT_INPUT'],
          lowerBound: ['0'],
        },
      ];
      const results: ResultRowType[] = [
        {
          ...EXAMPLE_ROW_RESULT,
          tokenin: '0xa',
          tokenout: '0xb',
        },
        {
          ...EXAMPLE_ROW_RESULT,
          tokenin: '0xa',
          tokenout: '0xc',
        },
        {
          ...EXAMPLE_ROW_RESULT,
          tokenin: '0xb',
          tokenout: '0xc',
        },
        {
          ...EXAMPLE_ROW_RESULT,
          tokenin: '0xc',
          tokenout: '0xd',
        },
      ];
      const filteredResults = filterResults(configs, results);
      // should only have 2 results, a -> b and c -> d
      expect(filteredResults).toHaveLength(2);
      expect(filteredResults[0]).toMatchObject(results[0]);
      expect(filteredResults[0].tokenin).toBe(configs[0].tokenIn);
      expect(filteredResults[0].tokenout).toBe(configs[0].tokenOut);
      expect(filteredResults[1]).toMatchObject(results[3]);
      expect(filteredResults[1].tokenin).toBe(configs[1].tokenIn);
      expect(filteredResults[1].tokenout).toBe(configs[1].tokenOut);
    });
  });
});
