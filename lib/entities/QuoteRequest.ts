import { TradeType } from '@uniswap/sdk-core';
import { BigNumber } from 'ethers';
import { getAddress } from 'ethers/lib/utils';

import { PostQuoteRequestBody } from '../handlers/quote/schema';

export interface QuoteRequestData {
  tokenInChainId: number;
  tokenOutChainId: number;
  requestId: string;
  offerer: string;
  tokenIn: string;
  amount: BigNumber;
  tokenOut: string;
  type: TradeType;
}

export interface QuoteRequestDataJSON extends Omit<QuoteRequestData, 'amount' | 'type'> {
  amount: string;
  type: string;
}

// data class for QuoteRequest helpers and conversions
export class QuoteRequest {
  public static fromRequestBody(body: PostQuoteRequestBody): QuoteRequest {
    return new QuoteRequest({
      tokenInChainId: body.tokenInChainId,
      tokenOutChainId: body.tokenOutChainId,
      requestId: body.requestId,
      offerer: getAddress(body.offerer),
      tokenIn: getAddress(body.tokenIn),
      tokenOut: getAddress(body.tokenOut),
      amount: BigNumber.from(body.amount),
      type: TradeType[body.type as keyof typeof TradeType],
    });
  }

  constructor(private data: QuoteRequestData) {}

  public toJSON(): QuoteRequestDataJSON {
    return {
      tokenInChainId: this.tokenInChainId,
      tokenOutChainId: this.tokenOutChainId,
      requestId: this.requestId,
      offerer: getAddress(this.offerer),
      tokenIn: getAddress(this.tokenIn),
      tokenOut: getAddress(this.tokenOut),
      amount: this.amount.toString(),
      type: TradeType[this.type],
    };
  }

  public get requestId(): string {
    return this.data.requestId;
  }

  public get tokenInChainId(): number {
    return this.data.tokenInChainId;
  }

  public get tokenOutChainId(): number {
    return this.data.tokenInChainId;
  }

  public get offerer(): string {
    return this.data.offerer;
  }

  public get tokenIn(): string {
    return this.data.tokenIn;
  }

  public get tokenOut(): string {
    return this.data.tokenOut;
  }

  public get amount(): BigNumber {
    return this.data.amount;
  }

  public get type(): TradeType {
    return this.data.type;
  }
}
