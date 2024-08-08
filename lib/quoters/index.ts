import { QuoteRequest, QuoteRequestDataJSON, QuoteResponse } from '../entities';

export enum QuoterType {
  TEST = 'TEST',
  ROUTER = 'ROUTER',
  RFQ = 'RFQ',
}

export interface Quoter {
  quote(request: QuoteRequest): Promise<QuoteResponse[]>;
  type(): QuoterType;
}

export interface FullRfqRequest {
  quoteRequest?: QuoteRequestDataJSON;
  metadata: {
    blocked: boolean;
    blockUntilTimestamp: number;
  };
}

export * from './MockQuoter';
export * from './WebhookQuoter';
