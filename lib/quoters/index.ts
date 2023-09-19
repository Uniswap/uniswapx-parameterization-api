import { QuoteRequest, QuoteResponse } from '../entities';
import { CircuitBreakerConfiguration } from '../providers/circuit-breaker';

export enum QuoterType {
  TEST = 'TEST',
  ROUTER = 'ROUTER',
  RFQ = 'RFQ',
}

export interface Quoter {
  quote(request: QuoteRequest): Promise<QuoteResponse[]>;
  consumeCircuitBreakerConfig(config: CircuitBreakerConfiguration[]): void;
  type(): QuoterType;
}

export * from './MockQuoter';
export * from './WebhookQuoter';
