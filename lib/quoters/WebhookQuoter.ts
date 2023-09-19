import { TradeType } from '@uniswap/sdk-core';
import { metric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import axios, { AxiosError, AxiosResponse } from 'axios';
import Logger from 'bunyan';

import { Quoter, QuoterType } from '.';
import { Metric, metricContext, QuoteRequest, QuoteResponse } from '../entities';
import { WebhookConfiguration, WebhookConfigurationProvider } from '../providers';
import { CircuitBreakerConfigurationProvider } from '../providers/circuit-breaker';

// TODO: shorten, maybe take from env config
const WEBHOOK_TIMEOUT_MS = 500;

// Quoter which fetches quotes from http endpoints
// endpoints must return well-formed QuoteResponse JSON
export class WebhookQuoter implements Quoter {
  private log: Logger;

  constructor(
    _log: Logger,
    private webhookProvider: WebhookConfigurationProvider,
    private circuitBreakerProvider: CircuitBreakerConfigurationProvider
  ) {
    this.log = _log.child({ quoter: 'WebhookQuoter' });
  }

  public async quote(request: QuoteRequest): Promise<QuoteResponse[]> {
    const endpoints = await this.getEligibleEndpoints();
    this.log.info(`Fetching quotes from ${endpoints.length} endpoints`, endpoints);
    const quotes = await Promise.all(endpoints.map((e) => this.fetchQuote(e, request)));
    return quotes.filter((q) => q !== null) as QuoteResponse[];
  }

  public type(): QuoterType {
    return QuoterType.RFQ;
  }

  private async getEligibleEndpoints(): Promise<WebhookConfiguration[]> {
    const endpoints = await this.webhookProvider.getEndpoints();
    const config = await this.circuitBreakerProvider.getConfigurations();
    const fillerToConfigMap = new Map(config.map((c) => [c.name, c]));
    if (config) {
      const enabledEndpoints: WebhookConfiguration[] = [];
      endpoints.forEach((e) => {
        if (
          (fillerToConfigMap.has(e.name) && fillerToConfigMap.get(e.name)?.enabled) ||
          !fillerToConfigMap.has(e.name) // default to allowing fillers not in the config
        ) {
          enabledEndpoints.push(e);
        }
      });
      return enabledEndpoints;
    }
    return endpoints;
  }

  private async fetchQuote(config: WebhookConfiguration, request: QuoteRequest): Promise<QuoteResponse | null> {
    const { name, endpoint, headers } = config;
    if (config.chainIds !== undefined && !config.chainIds.includes(request.tokenInChainId)) {
      this.log.debug(
        { configuredChainIds: config.chainIds, chainId: request.tokenInChainId },
        `chainId not configured for ${endpoint}`
      );
      return null;
    }

    metric.putMetric(Metric.RFQ_REQUESTED, 1, MetricLoggerUnit.Count);
    metric.putMetric(metricContext(Metric.RFQ_REQUESTED, name), 1, MetricLoggerUnit.Count);
    try {
      this.log.info({ request: request.toCleanJSON(), headers }, `Webhook request to: ${endpoint}`);
      this.log.info({ request: request.toOpposingCleanJSON(), headers }, `Webhook request to: ${endpoint}`);

      const before = Date.now();
      const timeoutOverride = config.overrides?.timeout;

      const axiosConfig = {
        timeout: timeoutOverride ? Number(timeoutOverride) : WEBHOOK_TIMEOUT_MS,
        ...(!!headers && { headers }),
      };
      const [hookResponse] = await Promise.all([
        axios.post(endpoint, request.toCleanJSON(), axiosConfig),
        axios.post(endpoint, request.toOpposingCleanJSON(), axiosConfig),
      ]);

      metric.putMetric(Metric.RFQ_RESPONSE_TIME, Date.now() - before, MetricLoggerUnit.Milliseconds);
      metric.putMetric(
        metricContext(Metric.RFQ_RESPONSE_TIME, name),
        Date.now() - before,
        MetricLoggerUnit.Milliseconds
      );

      const { response, validation } = QuoteResponse.fromRFQ(request, hookResponse.data, request.type);

      // RFQ provider explicitly elected not to quote
      if (isNonQuote(request, hookResponse, response)) {
        metric.putMetric(Metric.RFQ_NON_QUOTE, 1, MetricLoggerUnit.Count);
        metric.putMetric(metricContext(Metric.RFQ_NON_QUOTE, name), 1, MetricLoggerUnit.Count);
        this.log.info(
          {
            response: hookResponse.data,
            responseStatus: hookResponse.status,
          },
          `Webhook elected not to quote: ${endpoint}`
        );
        return null;
      }

      // RFQ provider response failed validation
      if (validation.error) {
        metric.putMetric(Metric.RFQ_FAIL_VALIDATION, 1, MetricLoggerUnit.Count);
        metric.putMetric(metricContext(Metric.RFQ_FAIL_VALIDATION, name), 1, MetricLoggerUnit.Count);
        this.log.error(
          {
            error: validation.error?.details,
            response,
            webhookUrl: endpoint,
          },
          `Webhook Response failed validation. Webhook: ${endpoint}.`
        );
        return null;
      }

      if (response.requestId !== request.requestId) {
        metric.putMetric(Metric.RFQ_FAIL_REQUEST_MATCH, 1, MetricLoggerUnit.Count);
        metric.putMetric(metricContext(Metric.RFQ_FAIL_REQUEST_MATCH, name), 1, MetricLoggerUnit.Count);
        this.log.error(
          {
            requestId: request.requestId,
            responseRequestId: response.requestId,
          },
          `Webhook ResponseId does not match request`
        );
        return null;
      }

      const quote = request.type === TradeType.EXACT_INPUT ? response.amountOut : response.amountIn;

      metric.putMetric(Metric.RFQ_SUCCESS, 1, MetricLoggerUnit.Count);
      metric.putMetric(metricContext(Metric.RFQ_SUCCESS, name), 1, MetricLoggerUnit.Count);
      this.log.info(
        {
          response: response.toLog(),
        },
        `WebhookQuoter: request ${
          request.requestId
        } for endpoint ${endpoint}: ${request.amount.toString()} -> ${quote.toString()}}`
      );
      return response;
    } catch (e) {
      metric.putMetric(Metric.RFQ_FAIL_ERROR, 1, MetricLoggerUnit.Count);
      metric.putMetric(metricContext(Metric.RFQ_FAIL_ERROR, name), 1, MetricLoggerUnit.Count);
      if (e instanceof AxiosError) {
        this.log.error(
          { endpoint, status: e.response?.status?.toString() },
          `Axios error fetching quote from ${endpoint}: ${e}`
        );
      } else {
        this.log.error({ endpoint }, `Error fetching quote from ${endpoint}: ${e}`);
      }
      return null;
    }
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
