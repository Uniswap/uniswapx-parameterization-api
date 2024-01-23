import { V2HardQuoteRequestBody } from '../../handlers/quote-v2';

export class V2HardQuoteRequest {
  public static fromRequestBody(body: V2HardQuoteRequestBody): V2HardQuoteRequest {
    return new V2HardQuoteRequest({
      requestId: body.requestId,
      quoteId: body.quoteId,
      tokenInChainId: body.tokenInChainId,
      tokenOutChainId: body.tokenOutChainId,
      encodedInnerOrder: body.encodedInnerOrder,
      innerSig: body.innerSig,
    });
  }

  constructor(private data: V2HardQuoteRequestBody) {}

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
}
