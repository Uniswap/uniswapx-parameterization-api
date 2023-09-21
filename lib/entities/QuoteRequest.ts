import { TradeType } from '@uniswap/sdk-core';
import { BigNumber, ethers } from 'ethers';
import { getAddress } from 'ethers/lib/utils';

import { PostQuoteRequestBody } from '../handlers/quote/schema';

export interface QuoteRequestData {
  tokenInChainId: number;
  tokenOutChainId: number;
  requestId: string;
  swapper: string;
  tokenIn: string;
  amount: BigNumber;
  tokenOut: string;
  type: TradeType;
  quoteId?: string;
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
      swapper: getAddress(body.swapper),
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
      swapper: getAddress(this.swapper),
      tokenIn: getAddress(this.tokenIn),
      tokenOut: getAddress(this.tokenOut),
      amount: this.amount.toString(),
      type: TradeType[this.type],
      ...(this.quoteId && { quoteId: this.quoteId }),
    };
  }

  public toCleanJSON(): QuoteRequestDataJSON {
    return {
      tokenInChainId: this.tokenInChainId,
      tokenOutChainId: this.tokenOutChainId,
      requestId: this.requestId,
      tokenIn: getAddress(this.tokenIn),
      tokenOut: getAddress(this.tokenOut),
      amount: this.amount.toString(),
      swapper: ethers.constants.AddressZero,
      type: TradeType[this.type],
      ...(this.quoteId && { quoteId: this.quoteId }),
    };
  }

  // return an opposing quote request,
  // i.e. quoting the other side of the trade
  public toOpposingCleanJSON(): QuoteRequestDataJSON {
    const type = this.type === TradeType.EXACT_INPUT ? TradeType.EXACT_OUTPUT : TradeType.EXACT_INPUT;
    return {
      tokenInChainId: this.tokenOutChainId,
      tokenOutChainId: this.tokenInChainId,
      requestId: this.requestId,
      // switch tokenIn/tokenOut
      tokenIn: getAddress(this.tokenOut),
      tokenOut: getAddress(this.tokenIn),
      amount: this.amount.toString(),
      swapper: ethers.constants.AddressZero,
      // switch tradeType
      type: TradeType[type],
      ...(this.quoteId && { quoteId: this.quoteId }),
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

  public get swapper(): string {
    return this.data.swapper;
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

  public get quoteId(): string | undefined {
    return this.data.quoteId;
  }

  public set quoteId(quoteId: string | undefined) {
    this.data.quoteId = quoteId;
  }
}
