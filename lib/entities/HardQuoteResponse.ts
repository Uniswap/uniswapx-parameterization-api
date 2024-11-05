import { CosignedV2DutchOrder, CosignedV3DutchOrder } from '@uniswap/uniswapx-sdk';
import { v4 as uuidv4 } from 'uuid';

import { HardQuoteRequest } from '.';
import { HardQuoteResponseData } from '../handlers/hard-quote/schema';
import { currentTimestampInMs, timestampInMstoSeconds } from '../util/time';

// data class for hard quote response helpers and conversions
export abstract class HardQuoteResponse<T extends CosignedV2DutchOrder | CosignedV3DutchOrder> {
  public createdAt: string;

  constructor(
    public request: HardQuoteRequest,
    public order: T,
    public createdAtMs = currentTimestampInMs()
  ) {
    this.createdAt = timestampInMstoSeconds(parseInt(this.createdAtMs));
  }

  public toResponseJSON(): HardQuoteResponseData {
    return {
      requestId: this.request.requestId,
      quoteId: this.request.quoteId,
      chainId: this.request.tokenInChainId,
      filler: this.order.info.cosignerData.exclusiveFiller,
      encodedOrder: this.order.serialize(),
      orderHash: this.order.hash(),
    };
  }

  public abstract toLog(): any;

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

  public get tokenOut(): string {
    return this.request.tokenOut;
  }

  public get filler(): string | undefined {
    return this.order.info.cosignerData.exclusiveFiller;
  }
}
