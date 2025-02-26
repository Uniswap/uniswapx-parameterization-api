import { KMSClient } from '@aws-sdk/client-kms';
import { TradeType } from '@uniswap/sdk-core';
import { KmsSigner } from '@uniswap/signer';
import { MetricLoggerUnit } from '@uniswap/smart-order-router';
import {
  CosignedV2DutchOrder,
  CosignedV3DutchOrder,
  CosignerData,
  OrderType,
  UniswapXOrderParser,
  UnsignedV2DutchOrder,
  UnsignedV3DutchOrder,
  V3CosignerData,
} from '@uniswap/uniswapx-sdk';
import { BigNumber, ethers } from 'ethers';
import Joi from 'joi';

import { POST_ORDER_ERROR_REASON, V3_BLOCK_BUFFER } from '../../constants';
import { HardQuoteRequest, Metric, QuoteResponse } from '../../entities';
import { V2HardQuoteResponse } from '../../entities/V2HardQuoteResponse';
import { V3HardQuoteResponse } from '../../entities/V3HardQuoteResponse';
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
      containerInjected: { quoters, orderServiceProvider, chainIdRpcMap },
      requestBody,
    } = params;
    const start = Date.now();

    metric.putMetric(Metric.QUOTE_REQUESTED, 1, MetricLoggerUnit.Count);

    const provider = chainIdRpcMap.get(requestBody.tokenInChainId);
    
    const orderParser = new UniswapXOrderParser();
    const orderType: OrderType = orderParser.getOrderTypeFromEncoded(
      requestBody.encodedInnerOrder,
      requestBody.tokenInChainId
    );
    const request = HardQuoteRequest.fromHardRequestBody(requestBody, orderType);
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
      bestQuote = await getBestQuote(quoters, request.toQuoteRequest(), log, metric, provider, RESPONSE_LOG_TYPE);
      if (!bestQuote && !requestBody.allowNoQuote) {
        if (!requestBody.allowNoQuote) {
          throw new NoQuotesAvailable();
        }
      }
    }

    let cosignerData: CosignerData | V3CosignerData;
    if (bestQuote) {
      cosignerData = getCosignerData(request, bestQuote, orderType);
      log.info({ bestQuote: bestQuote }, 'bestQuote');
    } else {
      cosignerData = await getDefaultCosignerData(request, orderType, provider);
      log.info({ cosignerData: cosignerData }, 'open order with default cosignerData');
    }

    const cosignedOrder = await createCosignedOrder(cosigner, request, cosignerData);
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
        const hardResponse = createHardQuoteResponse(request, cosignedOrder);
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

export function getCosignerData(
  request: HardQuoteRequest,
  quote: QuoteResponse,
  orderType: OrderType
): CosignerData | V3CosignerData {
  switch (orderType) {
    case OrderType.Dutch_V2: {
      const decayStartTime = getDecayStartTime(request.tokenInChainId);
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

      const v2Data: CosignerData = {
        decayStartTime,
        decayEndTime: getDecayEndTime(request.tokenInChainId, decayStartTime),
        exclusiveFiller: filler,
        exclusivityOverrideBps: DEFAULT_EXCLUSIVITY_OVERRIDE_BPS,
        inputOverride,
        outputOverrides,
      };
      return v2Data;
    }

    case OrderType.Dutch_V3: // fallthrough; currently not expecting users to use V3 for RFQ
    default:
      throw new Error('Unsupported order type');
  }
}
export async function getDefaultCosignerData(
  request: HardQuoteRequest,
  orderType: OrderType,
  provider: ethers.providers.JsonRpcProvider | undefined
): Promise<CosignerData | V3CosignerData> {
  switch (orderType) {
    case OrderType.Dutch_V2:
      return getDefaultV2CosignerData(request);
    case OrderType.Dutch_V3:
      return await getDefaultV3CosignerData(request, provider);
    default:
      throw new Error('Unsupported order type');
  }
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

function createHardQuoteResponse(
  request: HardQuoteRequest,
  order: CosignedV2DutchOrder | CosignedV3DutchOrder
): V2HardQuoteResponse | V3HardQuoteResponse {
  if (order instanceof CosignedV2DutchOrder) {
    return new V2HardQuoteResponse(request, order);
  } else if (order instanceof CosignedV3DutchOrder) {
    return new V3HardQuoteResponse(request, order);
  }
  throw new Error('Unsupported order type');
}

async function createCosignedOrder(
  cosigner: KmsSigner,
  request: HardQuoteRequest,
  cosignerData: CosignerData | V3CosignerData,
): Promise<CosignedV2DutchOrder | CosignedV3DutchOrder> {
  if (request.order instanceof UnsignedV2DutchOrder) {
    const v2CosignerData = cosignerData as CosignerData;
    const cosignature = await cosigner.signDigest(request.order.cosignatureHash(v2CosignerData));
    return CosignedV2DutchOrder.fromUnsignedOrder(request.order, v2CosignerData, cosignature);
  } else if (request.order instanceof UnsignedV3DutchOrder) {
    const v3CosignerData = cosignerData as V3CosignerData;
    const cosignature = await cosigner.signDigest(request.order.cosignatureHash(v3CosignerData));
    return CosignedV3DutchOrder.fromUnsignedOrder(request.order, v3CosignerData, cosignature);
  } else {
    throw new Error('Unsupported order type');
  }
}

function getDefaultV2CosignerData(request: HardQuoteRequest): CosignerData {
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

async function getDefaultV3CosignerData(request: HardQuoteRequest, provider: ethers.providers.JsonRpcProvider | undefined): Promise<V3CosignerData> {
  if (!provider)
    throw new Error(
      `No rpc provider found for chain: ${request.tokenInChainId}, which is required for V3 Dutch orders`
    );
  const currentBlock = await provider.getBlockNumber();

  return {
    decayStartBlock: currentBlock + V3_BLOCK_BUFFER,
    exclusiveFiller: ethers.constants.AddressZero,
    exclusivityOverrideBps: BigNumber.from(0),
    inputOverride: BigNumber.from(0),
    outputOverrides: request.order.info.outputs.map(() => BigNumber.from(0)),
  };
}