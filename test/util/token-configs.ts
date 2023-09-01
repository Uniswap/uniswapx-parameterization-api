import { TokenConfig, validateConfigs } from "../../lib/cron/synth-switch";

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
                    lowerBound: ['0']
                }
            ]
            expect(validateConfigs(badAddresses)).toStrictEqual([]);
        })
    })
});