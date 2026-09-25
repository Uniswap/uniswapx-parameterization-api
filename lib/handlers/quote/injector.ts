import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';

import { SoftQuoteBL } from '../../core';
import { SoftQuoteMetricDimension } from '../../entities/aws-metrics-logger';
import { ApiInjector } from '../base/api-handler';
import {
  BaseQuoteRequestInjected,
  buildQuoteContainerInjected,
  buildQuoteRequestInjected,
  createInjectorLogger,
} from '../shared/quote-injector';
import { PostQuoteRequestBody } from './schema';

/** What the /quote handler reads: only the flow. Its dependencies live inside it. */
export interface ContainerInjected {
  softQuote: SoftQuoteBL;
}

export interface RequestInjected extends BaseQuoteRequestInjected {}

export class QuoteInjector extends ApiInjector<ContainerInjected, RequestInjected, PostQuoteRequestBody, void> {
  public async buildContainerInjected(): Promise<ContainerInjected> {
    const log: Logger = createInjectorLogger(this.injectorName);

    const stage = process.env['stage'];

    const base = buildQuoteContainerInjected(log, stage);
    return { softQuote: new SoftQuoteBL(base.quoters, base.chainIdRpcMap) };
  }

  public async getRequestInjected(
    _containerInjected: ContainerInjected,
    requestBody: PostQuoteRequestBody,
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
      metricDimension: SoftQuoteMetricDimension,
    });
  }
}
