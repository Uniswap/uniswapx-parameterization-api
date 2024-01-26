import { TradeType } from '@uniswap/sdk-core';
import { BigNumber } from 'ethers';
import { HardQuoteRequestBody, V2RfqRequest } from '../../handlers/quote-v2';

export class HardQuoteRequest {
  public static fromRequestBody(body: HardQuoteRequestBody): HardQuoteRequest {
    return new HardQuoteRequest({
      requestId: body.requestId,
      quoteId: body.quoteId,
      tokenInChainId: body.tokenInChainId,
      tokenOutChainId: body.tokenOutChainId,
      encodedInnerOrder: body.encodedInnerOrder,
      innerSig: body.innerSig,
    });
  }

  constructor(private data: HardQuoteRequestBody) {}

  public toCleanJSON(): Omit<V2RfqRequest, 'quoteId'> & { quoteId?: string } {
    throw new Error('Method not implemented.');
  }

  public toOpposingCleanJSON(): Omit<V2RfqRequest, 'quoteId'> & { quoteId?: string } {
    throw new Error('Method not implemented.');
  }

  public toOpposingRequest(): HardQuoteRequest {
    throw new Error('Method not implemented.');
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

  public get encodedInnerOrder(): string {
    return this.data.encodedInnerOrder;
  }

  public get innerSig(): string {
    return this.data.innerSig;
  }

  public get quoteId(): string | undefined {
    return this.data.quoteId;
  }

  public set quoteId(quoteId: string | undefined) {
    this.data.quoteId = quoteId;
  }

  public get amount(): BigNumber {
    throw new Error('Method not implemented.');
  }

  public get swapper(): string {
    throw new Error('Method not implemented.');
  }

  public get type(): TradeType {
    throw new Error('Method not implemented.');
  }
}
