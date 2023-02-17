import { TradeType } from '@uniswap/sdk-core';
import axios from 'axios';
import Logger from 'bunyan';

import { Quoter, QuoterType } from '.';
import { QuoteRequest, QuoteResponse } from '../entities';
import { WebhookConfigurationProvider } from '../providers';

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
    const quotes = await Promise.all(endpoints.map((e) => this.fetchQuote(e, request)));
    return quotes.filter((q) => q !== null) as QuoteResponse[];
  }

  public type(): QuoterType {
    return QuoterType.RFQ;
  }

  private async fetchQuote(endpoint: string, request: QuoteRequest): Promise<QuoteResponse | null> {
    try {
      const hookResponse = await axios.post(endpoint, request.toJSON(), {
        timeout: WEBHOOK_TIMEOUT_MS,
      });

      const { response, validation } = QuoteResponse.fromResponseJSON(hookResponse.data, request.type);

      // TODO: remove, using for debugging purposes
      this.log.info(
        {
          response,
          validation,
        },
        `Webhook response from ${endpoint}`
      );

      if (validation.error) {
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
        this.log.error(
          {
            requestId: request.requestId,
            responseRequestId: response.requestId,
          },
          `Webhook ResponseId does not match request`
        );
        return null;
      }

      this.log.info(
        `WebhookQuoter: request ${request.requestId} for endpoint ${endpoint}: ${request.amount.toString()} -> ${
          response.type === TradeType.EXACT_INPUT ? response.amountOut.toString() : response.amountIn.toString()
        }}`
      );
      return response;
    } catch (e) {
      this.log.error(`Error fetching quote from ${endpoint}: ${e}`);
      return null;
    }
  }
}
