import { SynthSwitchQueryParams } from '../handlers/synth-switch';

export interface BaseSwitchRepository {
  putSynthSwitch(trade: SynthSwitchQueryParams, lower: string, enabled: boolean): Promise<void>;
  syntheticQuoteForTradeEnabled(trade: SynthSwitchQueryParams): Promise<boolean>;
}
