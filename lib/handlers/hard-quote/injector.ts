import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';

import { HardQuoteMetricDimension } from '../../entities/aws-metrics-logger';
import { checkDefined } from '../../preconditions/preconditions';
import { OrderServiceProvider, UniswapXServiceProvider } from '../../providers';
import { DynamoFillerAddressRepository, FillerAddressRepository } from '../../repositories/filler-address-repository';
import { DynamoPostedOrderRepository, PostedOrderRepository } from '../../repositories/posted-order-repository';
import { ApiInjector } from '../base/api-handler';
import {
  BaseQuoteContainerInjected,
  BaseQuoteRequestInjected,
  buildQuoteContainerInjected,
  buildQuoteRequestInjected,
  createInjectorLogger,
} from '../shared/quote-injector';
import { HardQuoteRequestBody } from './schema';

export interface ContainerInjected extends BaseQuoteContainerInjected {
  orderServiceProvider: OrderServiceProvider;
  // Bookkeeping sink for confirmed RFQ-won posts (see posted-order-recorder.ts).
  postedOrderRepository: PostedOrderRepository;
  // Winning filler address -> webhook attribution for the fade breaker, written by
  // recordPostedOrder alongside the PostedOrders row. Hard-quote only: the breaker scores
  // V2/V3 orders and every one of those is cosigned here, so /quote never touches this table.
  fillerAddressRepository: FillerAddressRepository;
}

export interface RequestInjected extends BaseQuoteRequestInjected {}

export class QuoteInjector extends ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void> {
  public async buildContainerInjected(): Promise<ContainerInjected> {
    const log: Logger = createInjectorLogger(this.injectorName);

    const stage = process.env['stage'];

    const orderServiceUrl = checkDefined(process.env.ORDER_SERVICE_URL, 'ORDER_SERVICE_URL is not defined');

    const base = buildQuoteContainerInjected(log, stage);

    return {
      ...base,
      orderServiceProvider: new UniswapXServiceProvider(log, orderServiceUrl),
      // Both build their own bounded DynamoDB client (the writes sit in series with the
      // response); construction is lazy (no I/O).
      postedOrderRepository: DynamoPostedOrderRepository.create(),
      fillerAddressRepository: DynamoFillerAddressRepository.create(),
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
