import { CosignedV3DutchOrder } from "@uniswap/uniswapx-sdk";
import { HardQuoteResponse } from "./HardQuoteResponse";

export class V3HardQuoteResponse extends HardQuoteResponse<CosignedV3DutchOrder> {
    public toLog() {
        return {
            quoteId: this.quoteId,
            requestId: this.requestId,
            tokenInChainId: this.chainId,
            tokenOutChainId: this.chainId,
            tokenIn: this.tokenIn,
            input: this.input,
            tokenOut: this.tokenOut,
            outputs: this.outputs,
            swapper: this.swapper,
            filler: this.filler,
            orderHash: this.order.hash(),
            createdAt: this.createdAt,
            createdAtMs: this.createdAtMs,
          };
    }

    get input() {
        const input = this.order.info.input;
        const relativeAmounts = input.curve.relativeAmounts.map((amount) => amount.toString());

        return {
            ...input,
            curve: {
                ...input.curve,
                relativeAmounts,
            },
        }
    }

    get outputs() {
        const processedOutputs = this.order.info.outputs.map((output) => {
            return {
                ...output,
                curve: {
                    ...output.curve,
                    relativeAmounts: output.curve.relativeAmounts.map((amount) => amount.toString()),
                }
            }
        });
        return processedOutputs;
    }
}