import { TokenConfig, validateConfigs } from "../../lib/cron/synth-switch";

describe('synth-switch util tests', () => {
    describe('validateConfigs', () => {
        it('filters out bad configs', () => {
            const badAddresses: TokenConfig[] = [
                {
                    inputToken: '0xdead',
                    outputToken: '0xbeef',
                    inputTokenChainId: 1,
                    outputTokenChainId: 1,
                    tradeTypes: ['EXACT_INPUT'],
                    lowerBound: ['0']
                }
            ]
            expect(validateConfigs(badAddresses)).toStrictEqual([]);
        })
    })
});