import { QuoteRequest, QuoteResponse } from '../entities';
import { Quoter, QuoterType } from '.';

export const MOCK_FILLER_ADDRESS = '0x0000000000000000000000000000000000000001';

// mock quoter which simply returns a quote at a preconfigured exchange rate
export class MockQuoter implements Quoter {
  constructor(private numerator: number, private denominator: number) {}

  public async quote(request: QuoteRequest): Promise<QuoteResponse> {
    return QuoteResponse.fromRequest(
      request,
      request.amountIn.mul(this.numerator).div(this.denominator),
      MOCK_FILLER_ADDRESS
    );
  }

  public type(): QuoterType {
    return QuoterType.TEST;
  }
}
