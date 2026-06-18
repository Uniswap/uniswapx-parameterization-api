import { TradeType } from '@uniswap/sdk-core';
import { metric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import axios, { AxiosError, AxiosResponse } from 'axios';
import Logger from 'bunyan';
import { ethers } from 'ethers';
import { v4 as uuidv4 } from 'uuid';

import { PermissionedTokenValidator } from '@uniswap/uniswapx-sdk';
import { Quoter, QuoterType } from '.';
import { getWebhookTimeoutMs, NOTIFICATION_TIMEOUT_MS } from '../constants';
import {
  AnalyticsEvent,
  AnalyticsEventType,
  Metric,
  metricContext,
  QuoteMetadata,
  QuoteRequest,
  QuoteResponse,
  WebhookResponseType,
} from '../entities';
import { ProtocolVersion, WebhookConfiguration, WebhookConfigurationProvider } from '../providers';
import { FirehoseLogger } from '../providers/analytics';
import { CircuitBreakerConfigurationProvider, EndpointStatuses } from '../providers/circuit-breaker';
import { FillerComplianceConfigurationProvider } from '../providers/compliance';
import { FillerAddressRepository } from '../repositories/filler-address-repository';
import { RFQValidator } from '../util/rfqValidator';
import { timestampInMstoISOString } from '../util/time';

// Quoter which fetches quotes from http endpoints
// endpoints must return well-formed QuoteResponse JSON
export class WebhookQuoter implements Quoter {
  private log: Logger;

  constructor(
    _log: Logger,
    private firehose: FirehoseLogger,
    private webhookProvider: WebhookConfigurationProvider,
    private circuitBreakerProvider: CircuitBreakerConfigurationProvider,
    private complianceProvider: FillerComplianceConfigurationProvider,
    private repository: FillerAddressRepository
  ) {
    this.log = _log.child({ quoter: 'WebhookQuoter' });
  }

  public async quote(
    request: QuoteRequest,
    provider?: ethers.providers.StaticJsonRpcProvider
  ): Promise<QuoteResponse[]> {
    const statuses = await this.getEndpointStatuses();
    const endpointToAddrsMap = await this.complianceProvider.getEndpointToExcludedAddrsMap();
    // Ignore endpoint status if token is permissioned
    const isPermissionedToken =
      PermissionedTokenValidator.isPermissionedToken(request.tokenIn, request.tokenInChainId) ||
      PermissionedTokenValidator.isPermissionedToken(request.tokenOut, request.tokenOutChainId);
    const baseFillerSet = isPermissionedToken
      ? statuses.enabled.concat(statuses.disabled.map((e) => e.webhook))
      : statuses.enabled;
    const enabledEndpoints = baseFillerSet.filter(
      (e) =>
        passFillerCompliance(e, endpointToAddrsMap, request.swapper) &&
        getEndpointSupportedProtocols(e).includes(request.protocol)
    );

    const disabledEndpoints = statuses.disabled;

    this.log.info(
      { requestId: request.requestId, enabled: enabledEndpoints, disabled: disabledEndpoints },
      `Fetching quotes from ${enabledEndpoints.length} endpoints and notifying disabled endpoints`
    );

    const quotes = await Promise.all(enabledEndpoints.map((e) => this.fetchQuote(e, request, provider)));

    // should not await and block
    if (!isPermissionedToken) {
      Promise.allSettled(disabledEndpoints.map((e) => this.notifyBlock(e))).then((results) => {
        this.log.info({ requestId: request.requestId, results }, 'Notified disabled endpoints');
      });
    }

    return quotes.filter((q) => q !== null) as QuoteResponse[];
  }

  public type(): QuoterType {
    return QuoterType.RFQ;
  }

  private async getEndpointStatuses(): Promise<EndpointStatuses> {
    const endpoints = await this.webhookProvider.getEndpoints();
    return this.circuitBreakerProvider.getEndpointStatuses(endpoints);
  }

  private async fetchQuote(
    config: WebhookConfiguration,
    request: QuoteRequest,
    provider?: ethers.providers.StaticJsonRpcProvider
  ): Promise<QuoteResponse | null> {
    const { name, endpoint, headers } = config;
    // Child logger so every log line in this RFQ attempt carries the request id.
    // quoteId is added once it's generated below (it's per-RFQ, so it doesn't exist
    // for the config-mismatch early returns that bail before any RFQ is sent).
    let log = this.log.child({ requestId: request.requestId });
    if (config.chainIds !== undefined && !config.chainIds.includes(request.tokenInChainId)) {
      log.debug(
        { configuredChainIds: config.chainIds, chainId: request.tokenInChainId },
        `chainId not configured for ${endpoint}`
      );
      return null;
    }
    if (!getEndpointSupportedProtocols(config).includes(request.protocol)) {
      log.debug(
        { config: config, requestdProtocol: request.protocol },
        `endpoint doesn't support the requested protocol`
      );
      return null;
    }

    metric.putMetric(Metric.RFQ_REQUESTED, 1, MetricLoggerUnit.Count);
    metric.putMetric(metricContext(Metric.RFQ_REQUESTED, name), 1, MetricLoggerUnit.Count);

    const cleanRequest = request.toCleanJSON();
    cleanRequest.quoteId = uuidv4();
    const opposingCleanRequest = request.toOpposingCleanJSON();
    opposingCleanRequest.quoteId = uuidv4();

    // Enrich the logger with the now-generated quoteId so all subsequent logs carry both ids.
    log = log.child({ quoteId: cleanRequest.quoteId });

    log.info({ request: cleanRequest, headers }, `Webhook request to: ${endpoint}`);
    log.info({ request: opposingCleanRequest, headers }, `Webhook request to: ${endpoint}`);

    const before = Date.now();
    const timeoutOverride = config.overrides?.timeout;

    const axiosConfig = {
      timeout: timeoutOverride ? Number(timeoutOverride) : getWebhookTimeoutMs(request.tokenInChainId),
      ...(!!headers && { headers }),
    };

    const requestContext = {
      requestId: cleanRequest.requestId,
      quoteId: cleanRequest.quoteId,
      name: name,
      endpoint: endpoint,
      requestTime: timestampInMstoISOString(before),
      timeoutSettingMs: axiosConfig.timeout,
    };

    try {
      // The opposing request is sent on the wire with a DISTINCT requestId so a market maker
      // cannot link it to the real request. Our logs keep the shared real requestId (via the
      // child logger above) so the two legs stay correlated for debugging.
      const opposingWireRequest = { ...opposingCleanRequest, requestId: uuidv4() };
      // Randomize which side is dispatched first so the genuine request isn't deterministically
      // sent ahead of the obfuscation request. The mapping back to real vs. opposing is tracked
      // explicitly, so quote selection and spread logging are unaffected.
      const realRequestFirst = Math.random() < 0.5;
      const orderedRequests = realRequestFirst
        ? [cleanRequest, opposingWireRequest]
        : [opposingWireRequest, cleanRequest];
      const [firstResponse, secondResponse] = await Promise.all(
        orderedRequests.map((req) => axios.post(endpoint, req, axiosConfig))
      );
      const hookResponse = realRequestFirst ? firstResponse : secondResponse;
      const opposite = realRequestFirst ? secondResponse : firstResponse;

      metric.putMetric(Metric.RFQ_RESPONSE_TIME, Date.now() - before, MetricLoggerUnit.Milliseconds);
      metric.putMetric(
        metricContext(Metric.RFQ_RESPONSE_TIME, name),
        Date.now() - before,
        MetricLoggerUnit.Milliseconds
      );

      log.info({ response: hookResponse.data, status: hookResponse.status }, `Raw webhook response from: ${endpoint}`);
      const rawResponse = {
        status: hookResponse.status,
        data: hookResponse.data,
        responseTime: timestampInMstoISOString(Date.now()),
        latencyMs: Date.now() - before,
        algo_id: hookResponse.data?.filler,
      };

      const metadata: QuoteMetadata = {
        endpoint: endpoint,
        fillerName: config.name,
      };

      const { response, validationError } = QuoteResponse.fromRFQ({
        request,
        data: hookResponse.data,
        type: request.type,
        metadata,
      });
      response.setFillerResponseLatencyMs(rawResponse.latencyMs);
      const validatePermissionedTokensError = await RFQValidator.validatePermissionedTokens(
        request,
        hookResponse.data,
        request.amount,
        response.amountOut,
        provider,
        log
      );

      // RFQ provider explicitly elected not to quote
      if (isNonQuote(request, hookResponse, response)) {
        metric.putMetric(Metric.RFQ_NON_QUOTE, 1, MetricLoggerUnit.Count);
        metric.putMetric(metricContext(Metric.RFQ_NON_QUOTE, name), 1, MetricLoggerUnit.Count);
        log.info(
          {
            response: hookResponse.data,
            responseStatus: hookResponse.status,
          },
          `Webhook elected not to quote: ${endpoint}`
        );
        this.firehose.sendAnalyticsEvent(
          new AnalyticsEvent(AnalyticsEventType.WEBHOOK_RESPONSE, {
            ...requestContext,
            ...rawResponse,
            responseType: WebhookResponseType.NON_QUOTE,
          })
        );
        return null;
      }

      // RFQ provider response failed validation
      if (validationError || validatePermissionedTokensError) {
        const error = validationError || validatePermissionedTokensError;
        metric.putMetric(Metric.RFQ_FAIL_VALIDATION, 1, MetricLoggerUnit.Count);
        metric.putMetric(metricContext(Metric.RFQ_FAIL_VALIDATION, name), 1, MetricLoggerUnit.Count);
        log.error(
          {
            error,
            response,
            webhookUrl: endpoint,
          },
          `Webhook Response failed validation. Webhook: ${endpoint}.`
        );
        this.firehose.sendAnalyticsEvent(
          new AnalyticsEvent(AnalyticsEventType.WEBHOOK_RESPONSE, {
            ...requestContext,
            ...rawResponse,
            responseType: WebhookResponseType.VALIDATION_ERROR,
            validationError: error,
          })
        );
        return null;
      }

      if (response.requestId !== request.requestId) {
        metric.putMetric(Metric.RFQ_FAIL_REQUEST_MATCH, 1, MetricLoggerUnit.Count);
        metric.putMetric(metricContext(Metric.RFQ_FAIL_REQUEST_MATCH, name), 1, MetricLoggerUnit.Count);
        log.error(
          {
            requestId: request.requestId,
            responseRequestId: response.requestId,
          },
          `Webhook ResponseId does not match request`
        );
        this.firehose.sendAnalyticsEvent(
          new AnalyticsEvent(AnalyticsEventType.WEBHOOK_RESPONSE, {
            ...requestContext,
            ...rawResponse,
            responseType: WebhookResponseType.REQUEST_ID_MISMATCH,
            mismatchedRequestId: response.requestId,
          })
        );
        return null;
      }

      const quote = request.type === TradeType.EXACT_INPUT ? response.amountOut : response.amountIn;

      metric.putMetric(Metric.RFQ_SUCCESS, 1, MetricLoggerUnit.Count);
      metric.putMetric(metricContext(Metric.RFQ_SUCCESS, name), 1, MetricLoggerUnit.Count);
      log.info(
        {
          response: response.toLog(),
          endpoint: endpoint,
        },
        `WebhookQuoter: request ${
          request.requestId
        } for endpoint ${endpoint} successful quote: ${request.amount.toString()} -> ${quote.toString()}}`
      );
      this.firehose.sendAnalyticsEvent(
        new AnalyticsEvent(AnalyticsEventType.WEBHOOK_RESPONSE, {
          ...requestContext,
          ...rawResponse,
          responseType: WebhookResponseType.OK,
        })
      );

      // do not await to minimize latency
      if (response.filler) {
        this.repository.addNewAddressToFiller(response.filler, endpoint);
      }
      //if valid quote, log the opposing side as well
      const opposingRequest = request.toOpposingRequest();
      const opposingResponse = QuoteResponse.fromRFQ({
        request: opposingRequest,
        data: opposite.data,
        type: opposingRequest.type,
        metadata,
      });
      if (
        opposingResponse &&
        !isNonQuote(opposingRequest, opposite, opposingResponse.response) &&
        !opposingResponse.validationError
      ) {
        opposingResponse.response.setFillerResponseLatencyMs(rawResponse.latencyMs);
        log.info({
          eventType: 'QuoteResponse',
          body: {
            ...opposingResponse.response.toLog(),
            // Correlate the opposing (bid/ask) log to the genuine request internally, even
            // though the opposing request was sent to the filler with a distinct requestId.
            requestId: request.requestId,
            offerer: opposingResponse.response.swapper,
            endpoint: endpoint,
            fillerName: config.name,
            algo_id: opposingResponse.response.filler,
          },
        });
      }

      return response;
    } catch (e) {
      metric.putMetric(Metric.RFQ_FAIL_ERROR, 1, MetricLoggerUnit.Count);
      metric.putMetric(metricContext(Metric.RFQ_FAIL_ERROR, name), 1, MetricLoggerUnit.Count);
      const errorLatency = {
        responseTime: timestampInMstoISOString(Date.now()),
        latencyMs: Date.now() - before,
      };
      if (e instanceof AxiosError) {
        log.error(
          { endpoint, status: e.response?.status?.toString() },
          `Axios error fetching quote from ${endpoint}: ${e}`
        );
        const axiosResponseType =
          e.code === 'ECONNABORTED' ? WebhookResponseType.TIMEOUT : WebhookResponseType.HTTP_ERROR;
        this.firehose.sendAnalyticsEvent(
          new AnalyticsEvent(AnalyticsEventType.WEBHOOK_RESPONSE, {
            ...requestContext,
            status: e.response?.status,
            data: e.response?.data,
            ...errorLatency,
            responseType: axiosResponseType,
            axiosError: `${e}`,
          })
        );
      } else {
        log.error({ endpoint }, `Error fetching quote from ${endpoint}: ${e}`);
        this.firehose.sendAnalyticsEvent(
          new AnalyticsEvent(AnalyticsEventType.WEBHOOK_RESPONSE, {
            ...requestContext,
            ...errorLatency,
            responseType: WebhookResponseType.OTHER_ERROR,
            otherError: `${e}`,
          })
        );
      }
      return null;
    }
  }

  private async notifyBlock(status: { webhook: WebhookConfiguration; blockUntil: number }): Promise<void> {
    const axiosConfig = {
      timeout: NOTIFICATION_TIMEOUT_MS,
      ...(!!status.webhook.headers && { headers: status.webhook.headers }),
    };
    axios
      .post(
        status.webhook.endpoint,
        {
          blockUntilTimestamp: status.blockUntil,
        },
        axiosConfig
      )
      .catch((_e) => {
        return;
      });
  }
}

// returns true if the given hook response is an explicit non-quote
// these should be treated differently from quote validation errors for analytics purposes
// valid non-quote responses:
// - 404
// - 0 amount quote
function isNonQuote(request: QuoteRequest, hookResponse: AxiosResponse, parsedResponse: QuoteResponse): boolean {
  if (hookResponse.status === 404) {
    return true;
  }

  const quote = request.type === TradeType.EXACT_INPUT ? parsedResponse.amountOut : parsedResponse.amountIn;
  if (quote.eq(0)) {
    return true;
  }

  return false;
}

export function getEndpointSupportedProtocols(e: WebhookConfiguration) {
  if (!e.supportedVersions || e.supportedVersions.length == 0) {
    return [ProtocolVersion.V2, ProtocolVersion.V3];
  }
  return e.supportedVersions;
}

export function passFillerCompliance(
  e: WebhookConfiguration,
  endpointToAddrsMap: Map<string, Set<string>>,
  swapper: string
) {
  return endpointToAddrsMap.get(e.endpoint) === undefined || !endpointToAddrsMap.get(e.endpoint)?.has(swapper);
}
