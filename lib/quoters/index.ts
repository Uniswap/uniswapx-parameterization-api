import { IndicativeQuoteResponse, QuoteRequest, QuoteResponse, V2QuoteRequest } from '../entities';

export enum QuoterType {
  TEST = 'TEST',
  ROUTER = 'ROUTER',
  RFQ = 'RFQ',
}

export interface Quoter {
  quote(request: QuoteRequest | V2QuoteRequest): Promise<QuoteResponse[] | IndicativeQuoteResponse[]>;
  type(): QuoterType;
}

export * from './MockQuoter';
export * from './WebhookQuoter';
