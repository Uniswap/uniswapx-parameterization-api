import { TradeType } from '@uniswap/sdk-core';
import { BigNumber } from 'ethers';
import { v4 as uuidv4 } from 'uuid';

import { QuoteRequestData } from '.';
import { PostQuoteResponse, RfqResponse, RfqResponseJoi } from '../handlers/quote/schema';
import { currentTimestampInMs, timestampInMstoSeconds } from '../util/time';

export interface QuoteResponseData
  extends Omit<QuoteRequestData, 'tokenInChainId' | 'tokenOutChainId' | 'amount' | 'type' | 'numOutputs'> {
  chainId: number;
  amountOut: BigNumber;
  amountIn: BigNumber;
  filler?: string;
  quoteId: string;
}

type ValidationError = {
  message: string | undefined;
  value: { [key: string]: any };
};

interface ValidatedResponse {
  response: QuoteResponse;
  validationError?: ValidationError;
}

// data class for QuoteRequest helpers and conversions
export class QuoteResponse implements QuoteResponseData {
  public createdAt: string;

  public static fromRequest(request: QuoteRequestData, amountQuoted: BigNumber, filler?: string): QuoteResponse {
    return new QuoteResponse(
      {
        chainId: request.tokenInChainId, // TODO: update schema
        requestId: request.requestId,
        swapper: request.swapper,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.type === TradeType.EXACT_INPUT ? request.amount : amountQuoted,
        amountOut: request.type === TradeType.EXACT_OUTPUT ? request.amount : amountQuoted,
        filler: filler,
        quoteId: request.quoteId ?? uuidv4(),
      },
      request.type
    );
  }

  public static fromRFQ(request: QuoteRequestData, data: RfqResponse, type: TradeType): ValidatedResponse {
    let validationError: ValidationError | undefined;

    const responseValidation = RfqResponseJoi.validate(data, {
      allowUnknown: true,
      stripUnknown: true,
    });

    if (responseValidation.error) {
      validationError = {
        message: responseValidation.error?.message,
        value: data,
      };
    }

    if (
      request.tokenIn.toLowerCase() !== data.tokenIn.toLowerCase() ||
      request.tokenOut.toLowerCase() !== data.tokenOut.toLowerCase()
    ) {
      validationError = {
        message: `RFQ response token mismatch: request tokenIn: ${request.tokenIn} tokenOut: ${request.tokenOut} response tokenIn: ${data.tokenIn} tokenOut: ${data.tokenOut}`,
        value: data,
      };
    }

    return {
      response: new QuoteResponse(
        {
          ...data,
          quoteId: data.quoteId ?? uuidv4(),
          swapper: request.swapper,
          amountIn: BigNumber.from(data.amountIn ?? 0),
          amountOut: BigNumber.from(data.amountOut ?? 0),
        },
        type
      ),
      ...(validationError && { validationError }),
    };
  }

  constructor(private data: QuoteResponseData, public type: TradeType, public createdAtMs = currentTimestampInMs()) {
    this.createdAt = timestampInMstoSeconds(parseInt(this.createdAtMs));
  }

  public toResponseJSON(): PostQuoteResponse & { quoteId: string } {
    return {
      quoteId: this.quoteId,
      chainId: this.chainId,
      requestId: this.requestId,
      tokenIn: this.tokenIn,
      amountIn: this.amountIn.toString(),
      tokenOut: this.tokenOut,
      amountOut: this.amountOut.toString(),
      swapper: this.swapper,
      filler: this.filler,
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
      swapper: this.swapper,
      filler: this.filler,
      createdAt: this.createdAt,
      createdAtMs: this.createdAtMs,
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

  public get swapper(): string {
    return this.data.swapper;
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
