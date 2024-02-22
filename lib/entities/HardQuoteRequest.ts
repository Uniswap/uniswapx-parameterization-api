import { TradeType } from '@uniswap/sdk-core';
import { V2DutchOrder } from '@uniswap/uniswapx-sdk';
import { BigNumber, utils } from 'ethers';
import { QuoteRequestDataJSON } from '.';
import { HardQuoteRequestBody } from '../handlers/hard-quote';

export class HardQuoteRequest {
  public order: V2DutchOrder;

  public static fromHardRequestBody(_body: HardQuoteRequestBody): HardQuoteRequest {
    // TODO: parse hard request into the same V2 request object format
    throw new Error('Method not implemented.');
  }

  constructor(private data: HardQuoteRequestBody) {
    this.order = V2DutchOrder.parse(data.encodedInnerOrder, data.tokenInChainId);
  }

  public toCleanJSON(): QuoteRequestDataJSON {
    return {
      tokenInChainId: this.tokenInChainId,
      tokenOutChainId: this.tokenOutChainId,
      swapper: utils.getAddress(this.swapper),
      requestId: this.requestId,
      tokenIn: this.tokenIn,
      tokenOut: this.tokenOut,
      amount: this.amount.toString(),
      type: TradeType[this.type],
      numOutputs: this.numOutputs,
      ...(this.quoteId && { quoteId: this.quoteId }),
    };
  }

  // return an opposing quote request,
  // i.e. quoting the other side of the trade
  public toOpposingCleanJSON(): QuoteRequestDataJSON {
    const type = this.type === TradeType.EXACT_INPUT ? TradeType.EXACT_OUTPUT : TradeType.EXACT_INPUT;
    return {
      tokenInChainId: this.tokenInChainId,
      tokenOutChainId: this.tokenOutChainId,
      requestId: this.requestId,
      swapper: utils.getAddress(this.swapper),
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
    return this.order.info.swapper;
  }

  public get tokenIn(): string {
    return utils.getAddress(this.order.info.input.token)
  }

  public get tokenOut(): string {
    return utils.getAddress(this.order.info.outputs[0].token);
  }

  public get amount(): BigNumber {
    if (this.type === TradeType.EXACT_INPUT) {
      return this.order.info.input.startAmount;
    } else {
      const amount = BigNumber.from(0);
      for (const output of this.order.info.outputs) {
        amount.add(output.startAmount);
      }

      return amount;
    }
  }

  public get type(): TradeType {
    return this.order.info.input.startAmount === this.order.info.input.endAmount ? TradeType.EXACT_INPUT : TradeType.EXACT_OUTPUT;
  }

  public get numOutputs(): number {
    return this.order.info.outputs.length;
  }

  public get cosigner(): string {
    return this.order.info.cosigner;
  }

  public get quoteId(): string | undefined {
    return this.data.quoteId;
  }

  public set quoteId(quoteId: string | undefined) {
    this.data.quoteId = quoteId;
  }
}
