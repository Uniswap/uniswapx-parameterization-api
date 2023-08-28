import { SynthSwitchRequestBody } from '../handlers/synth-switch';

export interface BaseSwitchRepository {
  putSynthSwitch(trade: SynthSwitchRequestBody, lower: string, upper: string, enabled: boolean): Promise<void>;
  syntheticQuoteForTradeEnabled(trade: SynthSwitchRequestBody): Promise<boolean>;
}
