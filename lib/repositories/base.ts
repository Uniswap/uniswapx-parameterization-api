import { SynthSwitchQueryParams, SynthSwitchTrade } from '../handlers/synth-switch';

export interface BaseSwitchRepository {
  putSynthSwitch(trade: SynthSwitchTrade, lower: string, enabled: boolean): Promise<void>;
  syntheticQuoteForTradeEnabled(trade: SynthSwitchQueryParams): Promise<boolean>;
}
