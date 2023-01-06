import { BigNumber } from 'ethers';
import { ValidationResult } from 'joi';

import { PostQuoteResponse, PostQuoteResponseJoi } from '../handlers/quote/schema';
import { QuoteRequestData } from '.';

export interface QuoteResponseData extends QuoteRequestData {
  amountOut: BigNumber;
  filler?: string;
}

interface ValidatedResponse {
  response: QuoteResponse;
  validation: ValidationResult<QuoteResponse>;
}

// data class for QuoteRequest helpers and conversions
export class QuoteResponse implements QuoteResponseData {
  public static fromRequest(request: QuoteRequestData, amountOut: BigNumber, filler?: string): QuoteResponse {
    return new QuoteResponse({
      chainId: request.chainId,
      requestId: request.requestId,
      offerer: request.offerer,
      tokenIn: request.tokenIn,
      amountIn: request.amountIn,
      tokenOut: request.tokenOut,
      amountOut: amountOut,
      filler: filler,
    });
  }

  public static fromResponseJSON(data: PostQuoteResponse): ValidatedResponse {
    const responseValidation = PostQuoteResponseJoi.validate(data, {
      allowUnknown: true,
      stripUnknown: true,
    });
    return {
      response: new QuoteResponse({
        ...data,
        amountIn: BigNumber.from(data.amountIn),
        amountOut: BigNumber.from(data.amountOut),
      }),
      validation: responseValidation,
    };
  }

  constructor(private data: QuoteResponseData) {}

  public toResponseJSON(): PostQuoteResponse {
    return {
      chainId: this.chainId,
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

  public get chainId(): number {
    return this.data.chainId;
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
