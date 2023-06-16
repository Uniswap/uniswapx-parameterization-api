import { TradeType } from '@uniswap/sdk-core';
import { metric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import axios, { AxiosResponse } from 'axios';
import Logger from 'bunyan';

import { Metric, metricContext, QuoteRequest, QuoteResponse } from '../entities';
import { WebhookConfiguration, WebhookConfigurationProvider } from '../providers';
import { Quoter, QuoterType } from '.';

// TODO: shorten, maybe take from env config
const WEBHOOK_TIMEOUT_MS = 500;

// Quoter which fetches quotes from http endpoints
// endpoints must return well-formed QuoteResponse JSON
export class WebhookQuoter implements Quoter {
  private log: Logger;

  constructor(_log: Logger, private webhookProvider: WebhookConfigurationProvider) {
    this.log = _log.child({ quoter: 'WebhookQuoter' });
  }

  public async quote(request: QuoteRequest): Promise<QuoteResponse[]> {
    const endpoints = await this.webhookProvider.getEndpoints();
    this.log.info(`Fetching quotes from ${endpoints.length} endpoints`, endpoints);
    const quotes = await Promise.all(endpoints.map((e) => this.fetchQuote(e, request)));
    return quotes.filter((q) => q !== null) as QuoteResponse[];
  }

  public type(): QuoterType {
    return QuoterType.RFQ;
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

    metric.putMetric(metricContext(Metric.RFQ_REQUESTED, name), 1, MetricLoggerUnit.Count);
    try {
      this.log.info({ request: request.toCleanJSON(), headers }, `Webhook request to: ${endpoint}`);

      const before = Date.now();
      const timeoutOverride = config.overrides?.timeout;
      const hookResponse = await axios.post(endpoint, request.toCleanJSON(), {
        timeout: timeoutOverride ? Number(timeoutOverride) : WEBHOOK_TIMEOUT_MS,
        ...(!!headers && { headers }),
      });

      metric.putMetric(
        metricContext(Metric.RFQ_RESPONSE_TIME, name),
        Date.now() - before,
        MetricLoggerUnit.Milliseconds
      );

      const { response, validation } = QuoteResponse.fromRFQ(request, hookResponse.data, request.type);

      // RFQ provider explicitly elected not to quote
      if (isNonQuote(request, hookResponse, response)) {
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

      metric.putMetric(metricContext(Metric.RFQ_SUCCESS, name), 1, MetricLoggerUnit.Count);
      this.log.info(
        `WebhookQuoter: request ${
          request.requestId
        } for endpoint ${endpoint}: ${request.amount.toString()} -> ${quote.toString()}}`
      );
      return response;
    } catch (e) {
      metric.putMetric(metricContext(Metric.RFQ_FAIL_ERROR, name), 1, MetricLoggerUnit.Count);
      this.log.error(`Error fetching quote from ${endpoint}: ${e}`);
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
