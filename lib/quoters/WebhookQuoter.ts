import { TradeType } from '@uniswap/sdk-core';
import { metric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import axios, { AxiosError, AxiosResponse } from 'axios';
import Logger from 'bunyan';
import { v4 as uuidv4 } from 'uuid';

import { Metric, metricContext, QuoteRequest, QuoteResponse } from '../entities';
import { WebhookConfiguration, WebhookConfigurationProvider } from '../providers';
import { CircuitBreakerConfigurationProvider } from '../providers/circuit-breaker';
import { Quoter, QuoterType } from '.';

// TODO: shorten, maybe take from env config
const WEBHOOK_TIMEOUT_MS = 500;

// Quoter which fetches quotes from http endpoints
// endpoints must return well-formed QuoteResponse JSON
export class WebhookQuoter implements Quoter {
  private log: Logger;
  private readonly ALLOW_LIST: Set<string>;

  constructor(
    _log: Logger,
    private webhookProvider: WebhookConfigurationProvider,
    private circuitBreakerProvider: CircuitBreakerConfigurationProvider,
    _allow_list: Set<string> = new Set<string>(['c96522e0d3c3a9adc593eecdfa66993bb37eb3a26603b08c8164f9ca3d631949'])
  ) {
    this.log = _log.child({ quoter: 'WebhookQuoter' });
    this.ALLOW_LIST = _allow_list;
  }

  public async quote(request: QuoteRequest): Promise<QuoteResponse[]> {
    const endpoints = await this.getEligibleEndpoints();
    this.log.info({ endpoints }, `Fetching quotes from ${endpoints.length} endpoints`);
    const quotes = await Promise.all(endpoints.map((e) => this.fetchQuote(e, request)));
    return quotes.filter((q) => q !== null) as QuoteResponse[];
  }

  public type(): QuoterType {
    return QuoterType.RFQ;
  }

  private async getEligibleEndpoints(): Promise<WebhookConfiguration[]> {
    const endpoints = await this.webhookProvider.getEndpoints();
    try {
      const config = await this.circuitBreakerProvider.getConfigurations();
      const fillerToConfigMap = new Map(config.map((c) => [c.hash, c]));
      if (config) {
        this.log.info({ fillerToCMap: [...fillerToConfigMap.entries()], config: config }, `Circuit breaker config used`)
        const enabledEndpoints: WebhookConfiguration[] = [];
        endpoints.forEach((e) => {
          if (
            this.ALLOW_LIST.has(e.hash) ||
            (fillerToConfigMap.has(e.hash) && fillerToConfigMap.get(e.hash)?.enabled) ||
            !fillerToConfigMap.has(e.hash) // default to allowing fillers not in the config
          ) {
            this.log.info({ endpoint: e }, `Endpoint enabled`)
            enabledEndpoints.push(e);
          }
        });
        return enabledEndpoints;
      }

      return endpoints;
    } catch (e) {
      this.log.error({ error: e }, `Error getting eligible endpoints, default to returning all`);
      return endpoints;
    }
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
      const cleanRequest = request.toCleanJSON();
      cleanRequest.quoteId = uuidv4();
      const opposingCleanRequest = request.toOpposingCleanJSON();
      opposingCleanRequest.quoteId = uuidv4();

      this.log.info({ request: cleanRequest, headers }, `Webhook request to: ${endpoint}`);
      this.log.info({ request: opposingCleanRequest, headers }, `Webhook request to: ${endpoint}`);

      const before = Date.now();
      const timeoutOverride = config.overrides?.timeout;

      const axiosConfig = {
        timeout: timeoutOverride ? Number(timeoutOverride) : WEBHOOK_TIMEOUT_MS,
        ...(!!headers && { headers }),
      };

      const [hookResponse] = await Promise.all([
        axios.post(endpoint, cleanRequest, axiosConfig),
        axios.post(endpoint, opposingCleanRequest, axiosConfig),
      ]);

      metric.putMetric(Metric.RFQ_RESPONSE_TIME, Date.now() - before, MetricLoggerUnit.Milliseconds);
      metric.putMetric(
        metricContext(Metric.RFQ_RESPONSE_TIME, name),
        Date.now() - before,
        MetricLoggerUnit.Milliseconds
      );

      this.log.info(
        { response: hookResponse.data, status: hookResponse.status },
        `Raw webhook response from: ${endpoint}`
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
          endpoint: endpoint,
        },
        `WebhookQuoter: request ${
          request.requestId
        } for endpoint ${endpoint} successful quote: ${request.amount.toString()} -> ${quote.toString()}}`
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
