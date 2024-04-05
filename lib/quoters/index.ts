import { QuoteRequest, QuoteResponse } from '../entities';
import { ProtocolVersion } from '../providers';

export enum QuoterType {
  TEST = 'TEST',
  ROUTER = 'ROUTER',
  RFQ = 'RFQ',
}

export interface Quoter {
  quote(request: QuoteRequest, version: ProtocolVersion): Promise<QuoteResponse[]>;
  type(): QuoterType;
}

export * from './MockQuoter';
export * from './WebhookQuoter';
