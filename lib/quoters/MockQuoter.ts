import { QuoteRequest, QuoteResponse } from '../entities';
import { Quoter } from '.';

export const MOCK_FILLER_ADDRESS = '0x0000000000000000000000000000000000000001';

// mock quoter which simply returns a 1:1 quote
export class MockQuoter implements Quoter {
    public async quote(request: QuoteRequest): Promise<QuoteResponse> {
        return QuoteResponse.fromRequest(
            request,
            request.amountIn,
            MOCK_FILLER_ADDRESS,
        );
    }
}
