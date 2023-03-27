import { TradeType } from '@uniswap/sdk-core';
import axios from 'axios';
import Logger from 'bunyan';

import { QuoteRequest, QuoteResponse } from '../entities';
import { WebhookConfiguration, WebhookConfigurationProvider } from '../providers';
import { Quoter, QuoterType } from '.';
import { ethers } from 'ethers';

// TODO: shorten, maybe take from env config
const WEBHOOK_TIMEOUT_MS = 500;

// Quoter which fetches quotes from http endpoints
// endpoints must return well-formed QuoteResponse JSON
export class WebhookQuoter implements Quoter {
  private log: Logger;

  constructor(_log: Logger, private webhookProvider: WebhookConfigurationProvider, private authSigningKey: ethers.utils.SigningKey) {
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

  private async fetchQuote(config: WebhookConfiguration, request: QuoteRequest): Promise<QuoteResponse | null> {
    const { endpoint, headers } = config;
    try {
      this.log.info({ request, headers }, `Webhook request to: ${endpoint}`);

      const hookResponse = await axios.post(endpoint, {
        ...request.toJSON(),
        // We sign the endpoint rather than the request body to avoid dealing with JSON serialization
        endpointSignature: this.authSigningKey.signDigest(ethers.utils.keccak256(endpoint))
      }, {
        timeout: WEBHOOK_TIMEOUT_MS,
        headers,
      });

      const { response, validation } = QuoteResponse.fromResponseJSON(hookResponse.data, request.type);

      // TODO: remove, using for debugging purposes
      this.log.info(
        {
          response,
          validation,
        },
        `Webhook response from: ${endpoint}`
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
