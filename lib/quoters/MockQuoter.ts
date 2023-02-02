import Logger from 'bunyan';
import { BigNumber } from 'ethers';

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
    let amountOut;
    if (
      request.tokenIn === '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' &&
      request.tokenOut === '0x6B175474E89094C44Da98b954EedeAC495271d0F'
    ) {
      amountOut = BigNumber.from(2000);
    } else {
      amountOut = request.amountIn.mul(this.numerator).div(this.denominator);
    }
    this.log.info(
      `MockQuoter: request ${request.requestId}: ${request.amountIn.toString()} -> ${amountOut.toString()}`
    );
    return [QuoteResponse.fromRequest(request, amountOut, MOCK_FILLER_ADDRESS)];
  }

  public type(): QuoterType {
    return QuoterType.TEST;
  }
}
