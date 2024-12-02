import { BigNumber } from "ethers";
import { HardQuoteResponse } from "./HardQuoteResponse";
import { CosignedV2DutchOrder } from "@uniswap/uniswapx-sdk";

export class V2HardQuoteResponse extends HardQuoteResponse<CosignedV2DutchOrder> {
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

    public get amountOut(): BigNumber {
        const resolved = this.order.resolve({
          timestamp: this.order.info.cosignerData.decayStartTime,
        });
        let amount = BigNumber.from(0);
        for (const output of resolved.outputs) {
          amount = amount.add(output.amount);
        }
    
        return amount;
      }
    
      public get amountIn(): BigNumber {
        const resolved = this.order.resolve({
          timestamp: this.order.info.cosignerData.decayStartTime,
        });
        return resolved.input.amount;
      }
}