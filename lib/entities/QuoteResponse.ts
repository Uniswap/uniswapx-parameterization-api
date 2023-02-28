import { TradeType } from '@uniswap/sdk-core';
import { BigNumber } from 'ethers';
import { ValidationResult } from 'joi';
import { v4 as uuidv4 } from 'uuid';

import { QuoteRequestData } from '.';
import { PostQuoteResponse, PostQuoteResponseJoi } from '../handlers/quote/schema';
import { currentTimestampInSeconds } from '../util/time';

export interface QuoteResponseData
  extends Omit<QuoteRequestData, 'tokenInChainId' | 'tokenOutChainId' | 'amount' | 'type'> {
  chainId: number;
  amountOut: BigNumber;
  amountIn: BigNumber;
  filler?: string;
  quoteId: string;
}

interface ValidatedResponse {
  response: QuoteResponse;
  validation: ValidationResult<QuoteResponse>;
}

// data class for QuoteRequest helpers and conversions
export class QuoteResponse implements QuoteResponseData {
  public static fromRequest(request: QuoteRequestData, amountQuoted: BigNumber, filler?: string): QuoteResponse {
    return new QuoteResponse(
      {
        chainId: request.tokenInChainId, // TODO: update schema
        requestId: request.requestId,
        quoteId: uuidv4(),
        offerer: request.offerer,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.type === TradeType.EXACT_INPUT ? request.amount : amountQuoted,
        amountOut: request.type === TradeType.EXACT_OUTPUT ? request.amount : amountQuoted,
        filler: filler,
      },
      request.type
    );
  }

  public static fromResponseJSON(data: PostQuoteResponse, type: TradeType): ValidatedResponse {
    const responseValidation = PostQuoteResponseJoi.validate(data, {
      allowUnknown: true,
      stripUnknown: true,
    });
    return {
      response: new QuoteResponse(
        {
          ...data,
          quoteId: uuidv4(),
          amountIn: BigNumber.from(data.amountIn),
          amountOut: BigNumber.from(data.amountOut),
        },
        type
      ),
      validation: responseValidation,
    };
  }

  constructor(
    private data: QuoteResponseData,
    public type: TradeType,
    public createdAt = currentTimestampInSeconds()
  ) {}

  public toResponseJSON(): PostQuoteResponse & { quoteId: string } {
    return {
      quoteId: this.quoteId,
      chainId: this.chainId,
      requestId: this.requestId,
      tokenIn: this.tokenIn,
      amountIn: this.amountIn.toString(),
      tokenOut: this.tokenOut,
      amountOut: this.amountOut.toString(),
      offerer: this.offerer,
    };
  }

  public toLog() {
    return {
      quoteId: this.quoteId,
      requestId: this.requestId,
      tokenInChainId: this.chainId,
      tokenOutChainId: this.chainId,
      tokenIn: this.tokenIn,
      amountIn: this.amountIn.toString(),
      tokenOut: this.tokenOut,
      amountOut: this.amountOut.toString(),
      offerer: this.offerer,
      filler: this.filler,
      createdAt: this.createdAt,
    };
  }

  public get quoteId(): string {
    return this.data.quoteId;
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
