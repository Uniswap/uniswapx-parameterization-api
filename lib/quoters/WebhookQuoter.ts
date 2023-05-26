import { TradeType } from '@uniswap/sdk-core';
import { metric, MetricLoggerUnit } from '@uniswap/smart-order-router';
import axios from 'axios';
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
    const { endpoint, headers } = config;
    if (config.chainIds !== undefined && !config.chainIds.includes(request.tokenInChainId)) {
      this.log.debug(
        { configuredChainIds: config.chainIds, chainId: request.tokenInChainId },
        `chainId not configured for ${endpoint}`
      );
      return null;
    }

    metric.putMetric(metricContext(Metric.RFQ_REQUESTED, endpoint), 1, MetricLoggerUnit.Count);
    try {
      this.log.info({ request, headers }, `Webhook request to: ${endpoint}`);

      const before = Date.now();
      const timeoutOverride = config.overrides?.timeout;
      const hookResponse = await axios.post(endpoint, request.toCleanJSON(), {
        timeout: timeoutOverride ? Number(timeoutOverride) : WEBHOOK_TIMEOUT_MS,
        ...(!!headers && { headers }),
      });
      metric.putMetric(
        metricContext(Metric.RFQ_RESPONSE_TIME, endpoint),
        Date.now() - before,
        MetricLoggerUnit.Milliseconds
      );

      const { response, validation } = QuoteResponse.fromRFQ(request, hookResponse.data, request.type);

      // TODO: remove, using for debugging purposes
      this.log.info(
        {
          response,
          validation,
        },
        `Webhook response from: ${endpoint}`
      );

      if (validation.error) {
        metric.putMetric(metricContext(Metric.RFQ_FAIL_VALIDATION, endpoint), 1, MetricLoggerUnit.Count);
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
        metric.putMetric(metricContext(Metric.RFQ_FAIL_REQUEST_MATCH, endpoint), 1, MetricLoggerUnit.Count);
        this.log.error(
          {
            requestId: request.requestId,
            responseRequestId: response.requestId,
          },
          `Webhook ResponseId does not match request`
        );
        return null;
      }

      metric.putMetric(metricContext(Metric.RFQ_SUCCESS, endpoint), 1, MetricLoggerUnit.Count);
      this.log.info(
        `WebhookQuoter: request ${request.requestId} for endpoint ${endpoint}: ${request.amount.toString()} -> ${
          response.type === TradeType.EXACT_INPUT ? response.amountOut.toString() : response.amountIn.toString()
        }}`
      );
      return response;
    } catch (e) {
      metric.putMetric(metricContext(Metric.RFQ_FAIL_ERROR, endpoint), 1, MetricLoggerUnit.Count);
      this.log.error(`Error fetching quote from ${endpoint}: ${e}`);
      return null;
    }
  }
}
