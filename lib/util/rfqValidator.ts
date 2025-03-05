import Logger from "bunyan";
import { ethers, BigNumber } from "ethers";
import { QuoteRequestData } from "../entities";
import { RfqResponse } from "../handlers/quote";
import { PermissionedTokenValidator } from "@uniswap/uniswapx-sdk";

export class RFQValidator {

  /**
   * Validates if a token requires permission checks and if so, performs the preTransferCheck
   * @param tokenAddress - The address of the token to validate
   * @param chainId - The chain ID where the token exists
   * @param from - The address tokens are being transferred from
   * @param to - The address tokens are being transferred to
   * @param amount - The amount of tokens being transferred (as a string)
   * @param provider - Optional JsonRpcProvider needed for permissioned token checks
   * @returns A string containing an error message if validation fails, undefined if successful
   */
  private static async validatePermissionedToken(
    tokenAddress: string,
    chainId: number,
    from: string,
    to: string,
    amount: string,
    provider?: ethers.providers.JsonRpcProvider
  ): Promise<string | undefined> {
    if (!PermissionedTokenValidator.isPermissionedToken(tokenAddress, chainId)) {
      return undefined;
    }

    if (!provider) {
      return `provider is required for permissioned token check for token: ${tokenAddress} on chain: ${chainId}`;
    }

    const isValid = await PermissionedTokenValidator.preTransferCheck(
      provider,
      tokenAddress,
      from,
      to,
      amount
    );

    if (!isValid) {
      return `preTransferCheck check failed for token: ${tokenAddress} from ${from} to ${to} with amount ${amount}`;
    }

    return undefined;
  }

  /**
   * Validates both input and output tokens for permission requirements and transfer validity
   * @param request - The quote request data containing token addresses and chain IDs
   * @param data - The RFQ response data containing filler information
   * @param amountIn - The input amount as a BigNumber
   * @param amountOut - The output amount as a BigNumber
   * @param provider - Optional JsonRpcProvider needed for permissioned token checks
   * @param log - Optional logger instance for error reporting
   * @returns A string containing the first error message encountered, undefined if all validations pass
   * @dev This function fails open (returns undefined) if an error occurs during validation
   * @dev Only performs checks if a filler address is provided in the RFQ response
   */
  public static async validatePermissionedTokens(
    request: QuoteRequestData,
    data: RfqResponse,
    amountIn: BigNumber,
    amountOut: BigNumber,
    provider?: ethers.providers.JsonRpcProvider,
    log?: Logger
  ): Promise<string | undefined> {
    
    if (!data.filler) {
      return undefined;
    }

    try {
      const [tokenInError, tokenOutError] = await Promise.all([
        this.validatePermissionedToken(
          request.tokenIn,
          request.tokenInChainId,
          request.swapper,
          data.filler,
          amountIn.toString(),
          provider
        ),
        this.validatePermissionedToken(
          request.tokenOut,
          request.tokenOutChainId,
          data.filler,
          request.swapper,
          amountOut.toString(),
          provider
        )
      ]);

      if (tokenInError) return tokenInError;
      if (tokenOutError) return tokenOutError;
    } catch (error) {
      // fail open, likely a dev error
      log?.error({ error }, 'error checking permissioned tokens');
    }

    return undefined;
  }
}