import { TradeType } from '@uniswap/sdk-core';
import { BigNumber, utils } from 'ethers';
import { HardQuoteRequestBody, IndicativeQuoteRequestBody, V2RfqRequest } from '../../handlers/quote-v2';

export interface V2QuoteRequestData extends Omit<IndicativeQuoteRequestBody, 'amount' | 'type'> {
  amount: BigNumber;
  type: TradeType;
  quoteId?: string;
}

export class V2QuoteRequest {
  public static fromRequestBody(body: IndicativeQuoteRequestBody): V2QuoteRequest {
    return new V2QuoteRequest({
      tokenInChainId: body.tokenInChainId,
      tokenOutChainId: body.tokenOutChainId,
      requestId: body.requestId,
      swapper: utils.getAddress(body.swapper),
      tokenIn: utils.getAddress(body.tokenIn),
      tokenOut: utils.getAddress(body.tokenOut),
      amount: BigNumber.from(body.amount),
      type: TradeType[body.type as keyof typeof TradeType],
      numOutputs: body.numOutputs,
      cosigner: utils.getAddress(body.cosigner),
    });
  }

  public static fromHardRequestBody(_body: HardQuoteRequestBody): V2QuoteRequest {
    // TODO: parse hard request into the same V2 request object format
    throw new Error('Method not implemented.');
  }

  constructor(private data: V2QuoteRequestData) {}

  public toJSON(): Partial<V2RfqRequest> & { cosigner: string } {
    return {
      tokenInChainId: this.tokenInChainId,
      tokenOutChainId: this.tokenOutChainId,
      requestId: this.requestId,
      tokenIn: utils.getAddress(this.tokenIn),
      tokenOut: utils.getAddress(this.tokenOut),
      amount: this.amount.toString(),
      type: TradeType[this.type],
      numOutputs: this.numOutputs,
      cosigner: utils.getAddress(this.cosigner),
      ...(this.quoteId && { quoteId: this.quoteId }),
    };
  }

  public toCleanJSON(): Omit<V2RfqRequest, 'quoteId'> & { quoteId?: string } {
    return {
      tokenInChainId: this.tokenInChainId,
      tokenOutChainId: this.tokenOutChainId,
      requestId: this.requestId,
      tokenIn: utils.getAddress(this.tokenIn),
      tokenOut: utils.getAddress(this.tokenOut),
      amount: this.amount.toString(),
      type: TradeType[this.type],
      numOutputs: this.numOutputs,
      ...(this.quoteId && { quoteId: this.quoteId }),
    };
  }

  // return an opposing quote request,
  // i.e. quoting the other side of the trade
  public toOpposingCleanJSON(): Omit<V2RfqRequest, 'quoteId'> & { quoteId?: string } {
    const type = this.type === TradeType.EXACT_INPUT ? TradeType.EXACT_OUTPUT : TradeType.EXACT_INPUT;
    return {
      tokenInChainId: this.tokenOutChainId,
      tokenOutChainId: this.tokenInChainId,
      requestId: this.requestId,
      // switch tokenIn/tokenOut
      tokenIn: utils.getAddress(this.tokenOut),
      tokenOut: utils.getAddress(this.tokenIn),
      amount: this.amount.toString(),
      // switch tradeType
      type: TradeType[type],
      numOutputs: this.numOutputs,
      ...(this.quoteId && { quoteId: this.quoteId }),
    };
  }

  public toOpposingRequest(): V2QuoteRequest {
    const opposingJSON = this.toOpposingCleanJSON();
    return new V2QuoteRequest({
      ...opposingJSON,
      amount: BigNumber.from(opposingJSON.amount),
      type: TradeType[opposingJSON.type as keyof typeof TradeType],
      swapper: this.swapper,
      cosigner: this.cosigner,
    });
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

  public get numOutputs(): number {
    return this.data.numOutputs;
  }

  public get cosigner(): string {
    return this.data.cosigner;
  }

  public get quoteId(): string | undefined {
    return this.data.quoteId;
  }

  public set quoteId(quoteId: string | undefined) {
    this.data.quoteId = quoteId;
  }
}
