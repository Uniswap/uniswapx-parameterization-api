import { HardQuoteRequest } from './HardRequest';
import { IndicativeQuoteRequest } from './IndicativeRequest';

export * from './HardRequest';
export * from './IndicativeRequest';

export type V2QuoteRequest = HardQuoteRequest | IndicativeQuoteRequest;
