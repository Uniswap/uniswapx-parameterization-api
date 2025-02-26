import { ethers } from 'ethers';
import { QuoteRequest, QuoteResponse } from '../entities';

export enum QuoterType {
  TEST = 'TEST',
  ROUTER = 'ROUTER',
  RFQ = 'RFQ',
}

export interface Quoter {
  quote(request: QuoteRequest, provider?: ethers.providers.JsonRpcProvider): Promise<QuoteResponse[]>;
  type(): QuoterType;
}

export * from './MockQuoter';
export * from './WebhookQuoter';
