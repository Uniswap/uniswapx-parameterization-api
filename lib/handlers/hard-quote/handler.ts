import { KMSClient } from '@aws-sdk/client-kms';
import { TradeType } from '@uniswap/sdk-core';
import { KmsSigner } from '@uniswap/signer';
import { MetricLoggerUnit } from '@uniswap/smart-order-router';
import { CosignedV2DutchOrder, CosignerData } from '@uniswap/uniswapx-sdk';
import { BigNumber, ethers } from 'ethers';
import Joi from 'joi';

import { POST_ORDER_ERROR_REASON } from '../../constants';
import { HardQuoteRequest, HardQuoteResponse, Metric, QuoteResponse } from '../../entities';
import { checkDefined } from '../../preconditions/preconditions';
import { ChainId } from '../../util/chains';
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
const RESPONSE_LOG_TYPE = 'HardResponse';
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
      containerInjected: { quoters, orderServiceProvider },
      requestBody,
    } = params;
    const start = Date.now();

    metric.putMetric(Metric.QUOTE_REQUESTED, 1, MetricLoggerUnit.Count);

    const request = HardQuoteRequest.fromHardRequestBody(requestBody);

    // re-create KmsClient every call to avoid clock skew issue
    // https://github.com/aws/aws-sdk-js-v3/issues/6400
    const kmsKeyId = checkDefined(process.env.KMS_KEY_ID, 'KMS_KEY_ID is not defined');
    const awsRegion = checkDefined(process.env.REGION, 'REGION is not defined');
    const cosigner = new KmsSigner(new KMSClient({ region: awsRegion }), kmsKeyId);
    const cosignerAddress = await cosigner.getAddress();

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

    let bestQuote;
    if (!requestBody.forceOpenOrder) {
      bestQuote = await getBestQuote(quoters, request.toQuoteRequest(), log, metric, RESPONSE_LOG_TYPE);
      if (!bestQuote && !requestBody.allowNoQuote) {
        if (!requestBody.allowNoQuote) {
          throw new NoQuotesAvailable();
        }
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
    const cosignature = await cosigner.signDigest(request.order.cosignatureHash(cosignerData));
    const cosignedOrder = CosignedV2DutchOrder.fromUnsignedOrder(request.order, cosignerData, cosignature);

    try {
      metric.putMetric(Metric.QUOTE_POST_ATTEMPT, 1, MetricLoggerUnit.Count);
      // if no quote and creating open order, create random new quoteId
      const response = await orderServiceProvider.postOrder({
        order: cosignedOrder,
        signature: request.innerSig,
        quoteId: bestQuote?.quoteId ?? request.quoteId,
        requestId: request.requestId,
      });
      if (response.statusCode == 200 || response.statusCode == 201) {
        metric.putMetric(Metric.QUOTE_200, 1, MetricLoggerUnit.Count);
        metric.putMetric(Metric.QUOTE_LATENCY, Date.now() - start, MetricLoggerUnit.Milliseconds);
        const hardResponse = new HardQuoteResponse(request, cosignedOrder);
        if (!bestQuote) {
          // The RFQ responses are logged in getBestQuote()
          // we log the Open Orders here
          log.info({
            eventType: RESPONSE_LOG_TYPE,
            body: {
              ...hardResponse.toLog(),
              offerer: request.swapper,
            },
          });
        }
        return {
          statusCode: 200,
          body: hardResponse.toResponseJSON(),
        };
      } else {
        const error = response as ErrorResponse;
        log.error({ error: error }, 'Error posting order');

        // user error should not be alerted on
        if (error.detail != POST_ORDER_ERROR_REASON.INSUFFICIENT_FUNDS) {
          metric.putMetric(Metric.QUOTE_POST_ERROR, 1, MetricLoggerUnit.Count);
        }
        metric.putMetric(Metric.QUOTE_400, 1, MetricLoggerUnit.Count);
        return {
          ...response,
          statusCode: 400,
        };
      }
    } catch (e) {
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
    case ChainId.MAINNET:
      return nowTimestamp + 24; // 2 blocks
    case ChainId.ARBITRUM_ONE:
      return nowTimestamp; // start immediately
    default:
      return nowTimestamp + 10; // 10 seconds
  }
}

function getDecayEndTime(chainId: number, startTime: number): number {
  switch (chainId) {
    case ChainId.MAINNET:
      return startTime + 60; // 5 blocks
    case ChainId.ARBITRUM_ONE:
      return startTime + 8; // 8 seconds
    default:
      return startTime + 30; // 30 seconds
  }
}
