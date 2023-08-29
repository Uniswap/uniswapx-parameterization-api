import { SynthSwitchRequestBody, SynthSwitchTrade } from '../handlers/synth-switch';

export interface BaseSwitchRepository {
  putSynthSwitch(trade: SynthSwitchTrade, lower: string, enabled: boolean): Promise<void>;
  syntheticQuoteForTradeEnabled(trade: SynthSwitchRequestBody): Promise<boolean>;
}
