import {QuoteRequest, QuoteResponse } from '../entities';

export interface Quoter {
    quote(request:QuoteRequest): Promise<QuoteResponse>;
}

export * from './MockQuoter';
