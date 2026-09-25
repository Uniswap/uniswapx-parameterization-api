import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';

import { HardQuoteBL, kmsCosignerFactory } from '../../core';
import { HardQuoteMetricDimension } from '../../entities/aws-metrics-logger';
import { checkDefined } from '../../preconditions/preconditions';
import { UniswapXServiceProvider } from '../../providers';
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

/** What the /hard-quote handler reads: only the flow. Its dependencies live inside it. */
export interface ContainerInjected {
  hardQuote: HardQuoteBL;
}

export interface RequestInjected extends BaseQuoteRequestInjected {}

export class QuoteInjector extends ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void> {
  public async buildContainerInjected(): Promise<ContainerInjected> {
    const log: Logger = createInjectorLogger(this.injectorName);

    const stage = process.env['stage'];

    const orderServiceUrl = checkDefined(process.env.ORDER_SERVICE_URL, 'ORDER_SERVICE_URL is not defined');

    const base = buildQuoteContainerInjected(log, stage);

    return {
      hardQuote: new HardQuoteBL({
        quoters: base.quoters,
        chainIdRpcMap: base.chainIdRpcMap,
        orderServiceProvider: new UniswapXServiceProvider(log, orderServiceUrl),
        // Both build their own bounded DynamoDB client (the writes sit in series with the
        // response); construction is lazy (no I/O).
        postedOrderRepository: DynamoPostedOrderRepository.create(),
        fillerAddressRepository: DynamoFillerAddressRepository.create(),
        cosignerFactory: kmsCosignerFactory(),
      }),
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
