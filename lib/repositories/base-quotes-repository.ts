import { QuoteRequest, QuoteResponse } from '../entities';

export interface BaseQuotesRepository {
  putRequest(request: QuoteRequest): Promise<void>;
  putResponses(responses: QuoteResponse[]): Promise<void>;
  getRequestById: (requestId: string) => Promise<QuoteRequest | null>;
  getAllResponsesByRequestId: (requestId: string) => Promise<QuoteResponse[]>;
}
