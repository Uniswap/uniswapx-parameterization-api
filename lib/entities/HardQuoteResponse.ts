import { CosignedV2DutchOrder } from '@uniswap/uniswapx-sdk';
import { BigNumber } from 'ethers';
import { v4 as uuidv4 } from 'uuid';

import { HardQuoteRequest } from '.';
import { HardQuoteResponseData } from '../handlers/hard-quote/schema';
import { currentTimestampInMs, timestampInMstoSeconds } from '../util/time';

// data class for hard quote response helpers and conversions
export class HardQuoteResponse {
  public createdAt: string;

  constructor(public request: HardQuoteRequest, public order: CosignedV2DutchOrder, public createdAtMs = currentTimestampInMs()) {
    this.createdAt = timestampInMstoSeconds(parseInt(this.createdAtMs));
  }

  public toResponseJSON(): HardQuoteResponseData {
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
      orderHash: this.order.hash(),
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
      orderHash: this.order.hash(),
      createdAt: this.createdAt,
      createdAtMs: this.createdAtMs,
    };
  }

  public get quoteId(): string {
    return this.request.quoteId ?? uuidv4();
  }

  public get requestId(): string {
    return this.request.requestId;
  }

  public get chainId(): number {
    return this.order.chainId;
  }

  public get swapper(): string {
    return this.request.swapper;
  }

  public get tokenIn(): string {
    return this.request.tokenIn;
  }

  public get amountOut(): BigNumber {
      const amount = BigNumber.from(0);
      for (const output of this.order.info.baseOutputs) {
        amount.add(output.startAmount);
      }

      return amount;
  }

  public get amountIn(): BigNumber {
      return this.order.info.baseInput.startAmount;
  }

  public get tokenOut(): string {
    return this.request.tokenOut;
  }

  public get filler(): string | undefined {
    return this.order.info.cosignerData.exclusiveFiller;
  }
}
