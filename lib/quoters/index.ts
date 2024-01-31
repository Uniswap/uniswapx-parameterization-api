import { QuoteRequest, QuoteResponse, V2QuoteRequest, V2QuoteResponse } from '../entities';

export enum QuoterType {
  TEST = 'TEST',
  ROUTER = 'ROUTER',
  RFQ = 'RFQ',
}

export interface Quoter {
  quote(request: QuoteRequest | V2QuoteRequest): Promise<QuoteResponse[] | V2QuoteResponse[]>;
  type(): QuoterType;
}

export * from './MockQuoter';
export * from './WebhookQuoter';
