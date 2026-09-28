import { ethers } from 'ethers';
import { QuoteRequest, QuoteResponse } from '../entities';
import { Context } from '../observability';

export enum QuoterType {
  TEST = 'TEST',
  RFQ = 'RFQ',
}

export interface Quoter {
  quote(
    ctx: Context,
    request: QuoteRequest,
    provider?: ethers.providers.StaticJsonRpcProvider
  ): Promise<QuoteResponse[]>;
  type(): QuoterType;
}

export * from './MockQuoter';
export * from './WebhookQuoter';
