import { DBQuoteRequest, DBQuoteResponse } from '../entities';

export interface BaseQuotesRepository {
  putRequest(request: DBQuoteRequest): Promise<void>;
  putResponses(responses: DBQuoteResponse[]): Promise<void>;
  getRequestById: (requestId: string) => Promise<DBQuoteRequest | null>;
  getAllResponsesByRequestId: (requestId: string) => Promise<DBQuoteResponse[]>;
}
