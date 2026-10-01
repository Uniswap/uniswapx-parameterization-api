import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';

import { loadHardQuoteConfig } from '../../config';
import { HardQuoteBL, kmsCosignerFactory } from '../../core';
import { HardQuoteMetricDimension } from '../../entities/aws-metrics-logger';
import { UniswapXServiceProvider } from '../../providers';
import { HARD_QUOTE_ANALYTICS_EVENT_TYPES, QuoteAnalytics, selectQuoteAnalytics } from '../../providers/analytics';
import { DynamoFillerAddressRepository } from '../../repositories/filler-address-repository';
import { DynamoPostedOrderRepository } from '../../repositories/posted-order-repository';
import { ApiInjector } from '../base/api-handler';
import {
  BaseQuoteRequestInjected,
  buildQuoteContainerInjected,
  buildQuoteRequestInjected,
  createInjectorLogger,
} from '../shared/quote-injector';
import { HardQuoteRequestBody } from './schema';

/** What the /hard-quote handler reads: the flow, and the analytics sink it flushes after each request. */
export interface ContainerInjected {
  hardQuote: HardQuoteBL;
  analytics: QuoteAnalytics;
}

export interface RequestInjected extends BaseQuoteRequestInjected {}

export class QuoteInjector extends ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void> {
  public async buildContainerInjected(): Promise<ContainerInjected> {
    const log: Logger = createInjectorLogger(this.injectorName);

    const config = loadHardQuoteConfig();

    const analytics = selectQuoteAnalytics(log, HARD_QUOTE_ANALYTICS_EVENT_TYPES, config.quoteAnalyticsStreams);
    const base = buildQuoteContainerInjected(log, config, analytics);

    return {
      hardQuote: new HardQuoteBL({
        quoters: base.quoters,
        chainIdRpcMap: base.chainIdRpcMap,
        orderServiceProvider: new UniswapXServiceProvider(log, config.orderServiceUrl),
        // Both build their own bounded DynamoDB client (the writes sit in series with the
        // response); construction is lazy (no I/O).
        postedOrderRepository: DynamoPostedOrderRepository.create(),
        fillerAddressRepository: DynamoFillerAddressRepository.create(),
        cosignerFactory: kmsCosignerFactory(config.cosigner),
        analytics,
      }),
      analytics,
    };
  }

  public async getRequestInjected(
    _containerInjected: ContainerInjected,
    requestBody: HardQuoteRequestBody,
    _requestQueryParams: void,
    _event: APIGatewayProxyEvent,
    context: Context,
    log: Logger,
    metricsLogger: MetricsLogger
  ): Promise<RequestInjected> {
    return buildQuoteRequestInjected({
      requestBody,
      context,
      log,
      metricsLogger,
      metricDimension: HardQuoteMetricDimension,
    });
  }
}
