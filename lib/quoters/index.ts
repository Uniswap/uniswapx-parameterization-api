import { QuoteRequest, QuoteResponse, V2QuoteRequest, V2QuoteResponse } from '../entities';

export enum QuoterType {
  TEST = 'TEST',
  ROUTER = 'ROUTER',
  RFQ = 'RFQ',
}

export interface V2Quoter {
  quote(request: V2QuoteRequest): Promise<V2QuoteResponse[]>;
  type(): QuoterType;
}

export interface Quoter {
  quote(request: QuoteRequest): Promise<QuoteResponse[]>;
  type(): QuoterType;
}

export * from './MockQuoter';
export * from './V2WebhookQuoter';
export * from './WebhookQuoter';
