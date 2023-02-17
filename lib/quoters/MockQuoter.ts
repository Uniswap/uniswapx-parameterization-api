import Logger from 'bunyan';

import { Quoter, QuoterType } from '.';
import { QuoteRequest, QuoteResponse } from '../entities';

export const MOCK_FILLER_ADDRESS = '0x0000000000000000000000000000000000000001';

// mock quoter which simply returns a quote at a preconfigured exchange rate
export class MockQuoter implements Quoter {
  private log: Logger;

  constructor(_log: Logger, private numerator: number, private denominator: number) {
    this.log = _log.child({ quoter: 'MockQuoter' });
  }

  public async quote(request: QuoteRequest): Promise<QuoteResponse[]> {
    const amountQuoted = request.amount.mul(this.numerator).div(this.denominator);

    this.log.info(
      `MockQuoter: request ${request.requestId}: ${request.amount.toString()} -> ${amountQuoted.toString()}`
    );
    return [QuoteResponse.fromRequest(request, amountQuoted, MOCK_FILLER_ADDRESS)];
  }

  public type(): QuoterType {
    return QuoterType.TEST;
  }
}
