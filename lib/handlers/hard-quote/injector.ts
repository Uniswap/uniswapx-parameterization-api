import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';

import { HardQuoteMetricDimension } from '../../entities/aws-metrics-logger';
import { checkDefined } from '../../preconditions/preconditions';
import { OrderServiceProvider, UniswapXServiceProvider } from '../../providers';
import { MockFillerComplianceConfigurationProvider } from '../../providers/compliance';
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
}

export interface RequestInjected extends BaseQuoteRequestInjected {}

export class QuoteInjector extends ApiInjector<ContainerInjected, RequestInjected, HardQuoteRequestBody, void> {
  public async buildContainerInjected(): Promise<ContainerInjected> {
    const log: Logger = createInjectorLogger(this.injectorName);

    const stage = process.env['stage'];

    const orderServiceUrl = checkDefined(process.env.ORDER_SERVICE_URL, 'ORDER_SERVICE_URL is not defined');

    // Hard quotes are cosigned and posted to the order service rather than dispatched
    // per-swapper, so no swapper-based filler exclusion applies. An empty config list makes
    // passFillerCompliance() always true and keeps the compliance S3 reads (and the
    // outbound compliance-list fetch) off this Lambda's hot path.
    const fillerComplianceProvider = new MockFillerComplianceConfigurationProvider([]);

    const base = buildQuoteContainerInjected(log, stage, fillerComplianceProvider);

    return {
      ...base,
      orderServiceProvider: new UniswapXServiceProvider(log, orderServiceUrl),
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
