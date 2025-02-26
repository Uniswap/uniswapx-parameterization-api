import { TradeType } from '@uniswap/sdk-core';
import { BigNumber, ethers } from 'ethers';
import { v4 as uuidv4 } from 'uuid';

import { QuoteRequestData } from '.';
import { PostQuoteResponse, RfqResponse, RfqResponseJoi } from '../handlers/quote/schema';
import { currentTimestampInMs, timestampInMstoSeconds } from '../util/time';
import Logger from 'bunyan';

export interface QuoteResponseData
  extends Omit<QuoteRequestData, 'tokenInChainId' | 'tokenOutChainId' | 'amount' | 'type' | 'numOutputs' | 'protocol'> {
  chainId: number;
  amountOut: BigNumber;
  amountIn: BigNumber;
  filler?: string;
  quoteId: string;
}

export interface QuoteMetadata {
  endpoint: string;
  fillerName: string;
}

type ValidationError = {
  message: string | undefined;
  value: { [key: string]: any };
};

interface ValidatedResponse {
  response: QuoteResponse;
  validationError?: ValidationError;
}

interface FromRfqArgs {
  request: QuoteRequestData;
  data: RfqResponse;
  type: TradeType;
  metadata: QuoteMetadata;
}

interface FromRequestArgs {
  request: QuoteRequestData;
  amountQuoted: BigNumber;
  metadata: QuoteMetadata;
  filler?: string;
}

// data class for QuoteRequest helpers and conversions
export class QuoteResponse implements QuoteResponseData {
  public createdAt: string;

  public static fromRequest(args: FromRequestArgs): QuoteResponse {
    const { request, amountQuoted, metadata, filler } = args;
    return new QuoteResponse(
      {
        chainId: request.tokenInChainId, // TODO: update schema
        requestId: request.requestId,
        swapper: request.swapper,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: request.type === TradeType.EXACT_INPUT ? request.amount : amountQuoted,
        amountOut: request.type === TradeType.EXACT_OUTPUT ? request.amount : amountQuoted,
        filler: filler,
        quoteId: request.quoteId ?? uuidv4(),
      },
      request.type,
      metadata
    );
  }

  public static async fromRFQ(args: FromRfqArgs, provider?: ethers.providers.JsonRpcProvider, log?: Logger): Promise<ValidatedResponse> {
    const { request, data, type, metadata } = args;
    let validationErrors: string[] = [];

    const responseValidation = RfqResponseJoi.validate(data, {
      allowUnknown: true,
      stripUnknown: true,
    });

    if (responseValidation?.error) {
      validationErrors.push(responseValidation.error?.message);
    }

    // ensure quoted tokens match
    if (
      request?.tokenIn?.toLowerCase() !== data?.tokenIn?.toLowerCase() ||
      request?.tokenOut?.toLowerCase() !== data?.tokenOut?.toLowerCase()
    ) {
      validationErrors.push(`RFQ response token mismatch: request tokenIn: ${request.tokenIn} tokenOut: ${request.tokenOut} response tokenIn: ${data.tokenIn} tokenOut: ${data.tokenOut}`);
    }

    // take quoted amount from RFQ response
    // but specified amount from request to avoid any inaccuracies from incorrect echoed response
    const [amountIn, amountOut] =
      request.type === TradeType.EXACT_INPUT
        ? [request.amount, BigNumber.from(data.amountOut ?? 0)]
        : [BigNumber.from(data.amountIn ?? 0), request.amount];

    // permissioned tokens check
    try {
      if(PermissionedTokenValidator.isPermissionedToken(request.tokenIn)) {
        if (!provider) {
          validationErrors.push(`provider is required for permissioned token check for tokenIn: ${request.tokenIn}`);
        } else {
          const preTransferCheckResult = await PermissionedTokenValidator.preTransferCheck(
            provider,
            request.tokenIn,
            request.swapper,
            data.filler,
            amountIn
        );

        if(!preTransferCheckResult) {
          validationErrors.push(`preTransferCheck check failed for tokenIn: ${request.tokenIn} from ${request.swapper} to ${data.filler} with amount ${amountIn}`);
          }
        }
      }
      if (PermissionedTokenValidator.isPermissionedToken(request.tokenOut)){
        if (!provider) {
          validationErrors.push(`provider is required for permissioned token check for tokenOut: ${request.tokenOut}`);
        } else {
          // permissioned token is tokenOut
          const preTransferCheckResult = await PermissionedTokenValidator.preTransferCheck(
            provider,
            request.tokenOut,
            data.filler,
            request.swapper,
            amountOut
          );

          if(!preTransferCheckResult) {
            validationErrors.push(`preTransferCheck check failed for tokenOut: ${request.tokenOut} from ${data.filler} to ${request.swapper} with amount ${amountOut}`);
          }
        }
      }
    } catch (error) {
      // fail open, likely a dev error
      log?.error({ error }, 'error checking permissioned tokens');
    }

    return {
      response: new QuoteResponse(
        {
          ...data,
          quoteId: data.quoteId ?? uuidv4(),
          swapper: request.swapper,
          amountIn,
          amountOut,
        },
        type,
        metadata
      ),
      ...(validationErrors.length > 0 && { validationError: {message: validationErrors.join(',\n'), value: data} }),
    };
  }

  constructor(
    private data: QuoteResponseData,
    public type: TradeType,
    public metadata: QuoteMetadata,
    public createdAtMs = currentTimestampInMs()
  ) {
    this.createdAt = timestampInMstoSeconds(parseInt(this.createdAtMs));
  }

  public toResponseJSON(): PostQuoteResponse & { quoteId: string } {
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
      createdAt: this.createdAt,
      createdAtMs: this.createdAtMs,
    };
  }

  public get quoteId(): string {
    return this.data.quoteId;
  }

  public get requestId(): string {
    return this.data.requestId;
  }

  public get chainId(): number {
    return this.data.chainId;
  }

  public get swapper(): string {
    return this.data.swapper;
  }

  public get tokenIn(): string {
    return this.data.tokenIn;
  }

  public get amountIn(): BigNumber {
    return this.data.amountIn;
  }

  public get tokenOut(): string {
    return this.data.tokenOut;
  }

  public get amountOut(): BigNumber {
    return this.data.amountOut;
  }

  public get filler(): string | undefined {
    return this.data.filler;
  }

  public get endpoint(): string {
    return this.metadata.endpoint;
  }

  public get fillerName(): string {
    return this.metadata.fillerName;
  }
}
