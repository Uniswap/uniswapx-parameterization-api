import { TradeType } from '@uniswap/sdk-core';
import { MetricLoggerUnit } from '@uniswap/smart-order-router';
import { CosignedV2DutchOrder, CosignerData } from '@uniswap/uniswapx-sdk';
import { BigNumber, ethers } from 'ethers';
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';

import { HardQuoteRequest, HardQuoteResponse, Metric, QuoteResponse } from '../../entities';
import { ProtocolVersion } from '../../providers';
import { NoQuotesAvailable, OrderPostError, UnknownOrderCosignerError } from '../../util/errors';
import { timestampInMstoSeconds } from '../../util/time';
import { APIGLambdaHandler } from '../base';
import { APIHandleRequestParams, ErrorResponse, Response } from '../base/api-handler';
import { getBestQuote } from '../quote/handler';
import { ContainerInjected, RequestInjected } from './injector';
import {
  HardQuoteRequestBody,
  HardQuoteRequestBodyJoi,
  HardQuoteResponseData,
  HardQuoteResponseDataJoi,
} from './schema';

const DEFAULT_EXCLUSIVITY_OVERRIDE_BPS = BigNumber.from(100); // non-exclusive fillers must override price by this much

export class QuoteHandler extends APIGLambdaHandler<
  ContainerInjected,
  RequestInjected,
  HardQuoteRequestBody,
  void,
  HardQuoteResponseData
> {
  public async handleRequest(
    params: APIHandleRequestParams<ContainerInjected, RequestInjected, HardQuoteRequestBody, void>
  ): Promise<ErrorResponse | Response<HardQuoteResponseData>> {
    const {
      requestInjected: { log, metric },
      containerInjected: { quoters, orderServiceProvider, cosigner, cosignerAddress },
      requestBody,
    } = params;
    const start = Date.now();

    metric.putMetric(Metric.QUOTE_REQUESTED, 1, MetricLoggerUnit.Count);

    log.info({ cosignerAddress: cosignerAddress }, 'cosignerAddress');
    const request = HardQuoteRequest.fromHardRequestBody(requestBody);

    // we dont have access to the cosigner key, throw
    if (request.order.info.cosigner !== cosignerAddress) {
      log.error({ cosignerInReq: request.order.info.cosigner, expected: cosignerAddress }, 'Unknown cosigner');
      throw new UnknownOrderCosignerError();
    }

    // Instead of decoding the order, we rely on frontend passing in the requestId
    //   from indicative quote
    log.info({
      eventType: 'HardRequest',
      body: {
        requestId: request.requestId,
        quoteId: request.quoteId,
        tokenInChainId: request.tokenInChainId,
        tokenOutChainId: request.tokenOutChainId,
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        offerer: request.swapper,
        amount: request.amount.toString(),
        type: TradeType[request.type],
        numOutputs: request.numOutputs,
        cosigner: request.order.info.cosigner,
        createdAt: timestampInMstoSeconds(start),
        createdAtMs: start.toString(),
      },
    });

    const bestQuote = await getBestQuote(
      quoters,
      request.toQuoteRequest(),
      log,
      metric,
      ProtocolVersion.V2,
      'HardResponse'
    );
    if (!bestQuote && !requestBody.allowNoQuote) {
      if (!requestBody.allowNoQuote) {
        throw new NoQuotesAvailable();
      }
    }

    let cosignerData: CosignerData;
    if (bestQuote) {
      cosignerData = getCosignerData(request, bestQuote);
      log.info({ bestQuote: bestQuote }, 'bestQuote');
    } else {
      cosignerData = getDefaultCosignerData(request);
      log.info({ cosignerData: cosignerData }, 'open order with default cosignerData');
    }

    // TODO: use server key to cosign instead of local wallet
    const cosignature = await cosigner.signDigest(request.order.cosignatureHash(cosignerData));
    const cosignedOrder = CosignedV2DutchOrder.fromUnsignedOrder(request.order, cosignerData, cosignature);

    try {
      metric.putMetric(Metric.QUOTE_POST_ATTEMPT, 1, MetricLoggerUnit.Count);
      // if no quote and creating open order, create random new quoteId
      await orderServiceProvider.postOrder(cosignedOrder, request.innerSig, bestQuote?.quoteId ?? uuidv4());
      metric.putMetric(Metric.QUOTE_200, 1, MetricLoggerUnit.Count);
      metric.putMetric(Metric.QUOTE_LATENCY, Date.now() - start, MetricLoggerUnit.Milliseconds);
      const response = new HardQuoteResponse(request, cosignedOrder);

      return {
        statusCode: 200,
        body: response.toResponseJSON(),
      };
    } catch (e) {
      log.error({ error: e }, 'Error posting order');
      metric.putMetric(Metric.QUOTE_400, 1, MetricLoggerUnit.Count);
      metric.putMetric(Metric.QUOTE_POST_ERROR, 1, MetricLoggerUnit.Count);
      throw new OrderPostError((e as Error).message);
    }
  }

  protected requestBodySchema(): Joi.ObjectSchema | null {
    return HardQuoteRequestBodyJoi;
  }

  protected requestQueryParamsSchema(): Joi.ObjectSchema | null {
    return null;
  }

  protected responseBodySchema(): Joi.ObjectSchema | null {
    return HardQuoteResponseDataJoi;
  }
}

export function getCosignerData(request: HardQuoteRequest, quote: QuoteResponse): CosignerData {
  const decayStartTime = getDecayStartTime(request.tokenInChainId);
  // default to open order with the original prices
  let filler = ethers.constants.AddressZero;
  let inputOverride = BigNumber.from(0);
  const outputOverrides = request.order.info.outputs.map(() => BigNumber.from(0));

  // if the quote is better, then increase amounts by the difference
  if (request.type === TradeType.EXACT_INPUT) {
    if (quote.amountOut.gt(request.totalOutputAmountStart)) {
      const increase = quote.amountOut.sub(request.totalOutputAmountStart);
      // give all the increase to the first (swapper) output
      outputOverrides[0] = request.order.info.outputs[0].startAmount.add(increase);
      if (quote.filler) {
        filler = quote.filler;
      }
    }
  } else {
    if (quote.amountIn.lt(request.totalInputAmountStart)) {
      inputOverride = quote.amountIn;
      if (quote.filler) {
        filler = quote.filler;
      }
    }
  }

  return {
    decayStartTime: decayStartTime,
    decayEndTime: getDecayEndTime(request.tokenInChainId, decayStartTime),
    exclusiveFiller: filler,
    exclusivityOverrideBps: DEFAULT_EXCLUSIVITY_OVERRIDE_BPS,
    inputOverride: inputOverride,
    outputOverrides: outputOverrides,
  };
}

export function getDefaultCosignerData(request: HardQuoteRequest): CosignerData {
  const decayStartTime = getDecayStartTime(request.tokenInChainId);
  const filler = ethers.constants.AddressZero;
  let inputOverride = BigNumber.from(0);
  const outputOverrides = request.order.info.outputs.map(() => BigNumber.from(0));
  if (request.type === TradeType.EXACT_INPUT) {
    outputOverrides[0] = request.totalOutputAmountStart;
  } else {
    inputOverride = request.totalInputAmountStart;
  }

  return {
    decayStartTime: decayStartTime,
    decayEndTime: getDecayEndTime(request.tokenInChainId, decayStartTime),
    exclusiveFiller: filler,
    exclusivityOverrideBps: DEFAULT_EXCLUSIVITY_OVERRIDE_BPS,
    inputOverride: inputOverride,
    outputOverrides: outputOverrides,
  };
}

function getDecayStartTime(chainId: number): number {
  const nowTimestamp = Math.floor(Date.now() / 1000);
  switch (chainId) {
    case 1:
      return nowTimestamp + 24; // 2 blocks
    default:
      return nowTimestamp + 10; // 10 seconds
  }
}

function getDecayEndTime(chainId: number, startTime: number): number {
  switch (chainId) {
    case 1:
      return startTime + 60; // 5 blocks
    default:
      return startTime + 30; // 30 seconds
  }
}
