import { BigNumber } from 'ethers';
import { v4 as uuidv4 } from 'uuid';

import { PostQuoteRequestBody } from '../handlers/quote/schema';

export interface QuoteRequestData {
  requestId: string;
  offerer: string;

  tokenIn: string;
  amountIn: BigNumber;

  tokenOut: string;
}

// data class for QuoteRequest helpers and conversions
export class QuoteRequest {
  public static fromRequestBody(body: PostQuoteRequestBody): QuoteRequest {
    return new QuoteRequest({
      requestId: uuidv4(),
      offerer: body.offerer,
      tokenIn: body.tokenIn,
      amountIn: BigNumber.from(body.amountIn),
      tokenOut: body.tokenOut,
    });
  }

  constructor(private data: QuoteRequestData) {}

  public get requestId(): string {
    return this.data.requestId;
  }

  public get offerer(): string {
    return this.data.offerer;
  }

  public get tokenIn(): string {
    return this.data.tokenIn;
  }

  public get amountIn(): BigNumber {
    return this.data.amountIn;
  }

  public get tokenOut(): string {
    return this.data.tokenOut;
  }
}
