import { TradeType } from '@uniswap/sdk-core';
import { MetricLoggerUnit } from '@uniswap/smart-order-router';
import { CosignedV2DutchOrder, CosignerData } from '@uniswap/uniswapx-sdk';
import { BigNumber, ethers } from 'ethers';
import Joi from 'joi';

import { HardQuoteRequest, HardQuoteResponse, Metric, QuoteResponse } from '../../entities';
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

const DEFAULT_EXCLUSIVITY_OVERRIDE_BPS = 100; // non-exclusive fillers must override price by this much

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

    metric.putMetric(Metric.HARD_QUOTE_REQUESTED, 1, MetricLoggerUnit.Count);

    const request = HardQuoteRequest.fromHardRequestBody(requestBody);

    // we dont have access to the cosigner key, throw
    if (request.order.info.cosigner !== cosignerAddress) {
      log.error({ cosigner: request.order.info.cosigner }, 'Unknown cosigner');
      throw new UnknownOrderCosignerError();
    }

    // TODO: finalize on v2 metrics logging
    log.info({
      eventType: 'HardQuoteRequest',
      body: {
        requestId: request.requestId,
        tokenInChainId: request.tokenInChainId,
        tokenOutChainId: request.tokenInChainId,
        encoded: requestBody.encodedInnerOrder,
        sig: requestBody.innerSig,
        createdAt: timestampInMstoSeconds(start),
        createdAtMs: start.toString(),
      },
    });

    const bestQuote = await getBestQuote(quoters, request.toQuoteRequest(), log, metric);
    if (!bestQuote) {
      metric.putMetric(Metric.HARD_QUOTE_404, 1, MetricLoggerUnit.Count);
      throw new NoQuotesAvailable();
    }

    log.info({ bestQuote: bestQuote }, 'bestQuote');

    // TODO: use server key to cosign instead of local wallet
    const cosignerData = getCosignerData(request, bestQuote);
    const cosignature = await cosigner.signDigest(request.order.cosignatureHash(cosignerData));
    const cosignedOrder = CosignedV2DutchOrder.fromUnsignedOrder(request.order, cosignerData, cosignature);

    try {
      await orderServiceProvider.postOrder(cosignedOrder, request.innerSig, request.quoteId);
    } catch (e) {
      metric.putMetric(Metric.HARD_QUOTE_400, 1, MetricLoggerUnit.Count);
      throw new OrderPostError();
    }

    metric.putMetric(Metric.HARD_QUOTE_200, 1, MetricLoggerUnit.Count);
    metric.putMetric(Metric.HARD_QUOTE_LATENCY, Date.now() - start, MetricLoggerUnit.Milliseconds);
    const response = new HardQuoteResponse(request, cosignedOrder);

    return {
      statusCode: 200,
      body: response.toResponseJSON(),
    };
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
  let inputAmount = BigNumber.from(0);
  const outputAmounts = request.order.info.baseOutputs.map(() => BigNumber.from(0));

  // if the quote is better, then increase amounts by the difference
  if (request.type === TradeType.EXACT_INPUT) {
    if (quote.amountOut.gt(request.totalOutputAmountStart)) {
      const increase = quote.amountOut.sub(request.totalOutputAmountStart);
      // give all the increase to the first (swapper) output
      outputAmounts[0] = request.order.info.baseOutputs[0].startAmount.add(increase);
      if (quote.filler) {
        filler = quote.filler;
      }
    }
  } else {
    if (quote.amountIn.lt(request.totalInputAmountStart)) {
      inputAmount = quote.amountIn;
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
    inputAmount: inputAmount,
    outputAmounts: outputAmounts,
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
