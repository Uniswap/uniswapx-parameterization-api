import Logger from 'bunyan';
import { BigNumber } from 'ethers';

import { Quoter, QuoterType, V2Quoter } from '.';
import { QuoteRequest, QuoteResponse, V2QuoteRequest, V2QuoteResponse } from '../entities';

export const MOCK_FILLER_ADDRESS = '0x0000000000000000000000000000000000000001';

// mock quoter which simply returns a quote at a preconfigured exchange rate
export class MockQuoter implements Quoter {
  private log: Logger;

  constructor(_log: Logger, private numerator?: number, private denominator?: number) {
    this.log = _log.child({ quoter: 'MockQuoter' });
  }

  public async quote(request: QuoteRequest): Promise<QuoteResponse[]> {
    const amountQuoted =
      this.denominator && this.numerator ? request.amount.mul(this.numerator).div(this.denominator) : BigNumber.from(1);

    this.log.info(
      `MockQuoter: request ${request.requestId}: ${request.amount.toString()} -> ${amountQuoted.toString()}`
    );
    return [QuoteResponse.fromRequest(request, amountQuoted, MOCK_FILLER_ADDRESS)];
  }

  public type(): QuoterType {
    return QuoterType.TEST;
  }
}

export class V2MockQuoter implements V2Quoter {
  private log: Logger;

  constructor(_log: Logger, private numerator?: number, private denominator?: number) {
    this.log = _log.child({ quoter: 'MockQuoter' });
  }

  public async quote(request: V2QuoteRequest): Promise<V2QuoteResponse[]> {
    const amountQuoted =
      this.denominator && this.numerator ? request.amount.mul(this.numerator).div(this.denominator) : BigNumber.from(1);

    this.log.info(
      `MockQuoter: request ${request.requestId}: ${request.amount.toString()} -> ${amountQuoted.toString()}`
    );
    return [V2QuoteResponse.fromRequest(request, amountQuoted, MOCK_FILLER_ADDRESS)];
  }

  public type(): QuoterType {
    return QuoterType.TEST;
  }
}
