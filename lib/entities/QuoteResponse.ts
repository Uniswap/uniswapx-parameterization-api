import { BigNumber } from 'ethers';

import { PostQuoteResponse } from '../handlers/quote/schema';
import { QuoteRequestData } from '.';

export interface QuoteResponseData extends QuoteRequestData {
  amountOut: BigNumber;
  filler?: string;
}

// data class for QuoteRequest helpers and conversions
export class QuoteResponse implements QuoteResponseData {
  public static fromRequest(request: QuoteRequestData, amountOut: BigNumber, filler?: string): QuoteResponse {
    return new QuoteResponse({
      requestId: request.requestId,
      offerer: request.offerer,
      tokenIn: request.tokenIn,
      amountIn: request.amountIn,
      tokenOut: request.tokenOut,
      amountOut: amountOut,
      filler: filler,
    });
  }

  constructor(private data: QuoteResponseData) {}

  public toResponse(): PostQuoteResponse {
    return {
      requestId: this.requestId,
      tokenIn: this.tokenIn,
      amountIn: this.amountIn.toString(),
      tokenOut: this.tokenOut,
      amountOut: this.amountOut.toString(),
      offerer: this.offerer,
    };
  }

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

  public get amountOut(): BigNumber {
    return this.data.amountOut;
  }

  public get filler(): string | undefined {
    return this.data.filler;
  }
}
