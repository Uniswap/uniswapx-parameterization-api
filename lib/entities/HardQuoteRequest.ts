import { TradeType } from '@uniswap/sdk-core';
import { OrderType, UnsignedV2DutchOrder } from '@uniswap/uniswapx-sdk';
import { BigNumber, ethers, utils } from 'ethers';
import { v4 as uuidv4 } from 'uuid';

import { QuoteRequest, QuoteRequestDataJSON } from '.';
import { HardQuoteRequestBody } from '../handlers/hard-quote';
import { ProtocolVersion } from '../providers';

export class HardQuoteRequest {
  public order: UnsignedV2DutchOrder;
  private data: HardQuoteRequestBody;

  public static fromHardRequestBody(body: HardQuoteRequestBody, orderType: OrderType): HardQuoteRequest {
    return new HardQuoteRequest(body, orderType);
  }

  constructor(_data: HardQuoteRequestBody, orderType: OrderType) {
    this.data = {
      ..._data,
      requestId: _data.quoteId ?? uuidv4(),
    };
    if (orderType === OrderType.Dutch_V2) {
      this.order = UnsignedV2DutchOrder.parse(_data.encodedInnerOrder, _data.tokenInChainId);
    // } else if (orderType === OrderType.Dutch_V3) {
    //   this.order = UnsignedV3DutchOrder.parse(_data.encodedInnerOrder, _data.tokenInChainId);
    // } 
    } else {
      throw new Error('Unsupported order type');
    }
  }

  public toCleanJSON(): QuoteRequestDataJSON {
    return {
      tokenInChainId: this.tokenInChainId,
      tokenOutChainId: this.tokenOutChainId,
      swapper: ethers.constants.AddressZero,
      requestId: this.requestId,
      tokenIn: this.tokenIn,
      tokenOut: this.tokenOut,
      amount: this.amount.toString(),
      type: TradeType[this.type],
      numOutputs: this.numOutputs,
      ...(this.quoteId && { quoteId: this.quoteId }),
      protocol: ProtocolVersion.V2,
    };
  }

  // return an opposing quote request,
  // i.e. quoting the other side of the trade
  public toOpposingCleanJSON(): QuoteRequestDataJSON {
    const type = this.type === TradeType.EXACT_INPUT ? TradeType.EXACT_OUTPUT : TradeType.EXACT_INPUT;
    return {
      ...this.toCleanJSON(),
      // switch tokenIn/tokenOut
      tokenIn: utils.getAddress(this.tokenOut),
      tokenOut: utils.getAddress(this.tokenIn),
      amount: this.amount.toString(),
      // switch tradeType
      type: TradeType[type],
    };
  }

  // transforms into a quote request that can be used to query quoters
  public toQuoteRequest(): QuoteRequest {
    return new QuoteRequest({
      ...this.toCleanJSON(),
      swapper: this.swapper,
      amount: this.amount,
      type: this.type,
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
    return this.order.info.swapper;
  }

  public get tokenIn(): string {
    return utils.getAddress(this.order.info.input.token);
  }

  public get tokenOut(): string {
    return utils.getAddress(this.order.info.outputs[0].token);
  }

  public get totalOutputAmountStart(): BigNumber {
    let amount = BigNumber.from(0);
    for (const output of this.order.info.outputs) {
      amount = amount.add(output.startAmount);
    }

    return amount;
  }

  public get totalInputAmountStart(): BigNumber {
    return this.order.info.input.startAmount;
  }

  public get amount(): BigNumber {
    if (this.type === TradeType.EXACT_INPUT) {
      return this.totalInputAmountStart;
    } else {
      return this.totalOutputAmountStart;
    }
  }

  public get type(): TradeType {
    if (this.order instanceof UnsignedV2DutchOrder) {
      return this.order.info.input.startAmount.eq(this.order.info.input.endAmount)
        ? TradeType.EXACT_INPUT
        : TradeType.EXACT_OUTPUT
    } 
    // else if (this.order instanceof UnsignedV3DutchOrder) {
    //   const startAmount = this.order.info.input.startAmount;
    //   return startAmount.eq(V3DutchOrderBuilder.getMinAmountOut(startAmount, this.order.info.input.curve.relativeAmounts))
    //     ? TradeType.EXACT_INPUT
    //     : TradeType.EXACT_OUTPUT
    // } 
    else {
      throw new Error('Unsupported order type');
    }
  }

  public get numOutputs(): number {
    return this.order.info.outputs.length;
  }

  public get cosigner(): string {
    return this.order.info.cosigner;
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
