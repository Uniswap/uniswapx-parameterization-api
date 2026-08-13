import { MetricsLogger } from 'aws-embedded-metrics';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { default as Logger } from 'bunyan';

import { BETA_COMPLIANCE_S3_KEY, COMPLIANCE_CONFIG_BUCKET, PROD_COMPLIANCE_S3_KEY } from '../../constants';
import { SoftQuoteMetricDimension } from '../../entities/aws-metrics-logger';
import { S3FillerComplianceConfigurationProvider } from '../../providers/compliance/s3';
import { STAGE } from '../../util/stage';
import { ApiInjector } from '../base/api-handler';
import {
  BaseQuoteContainerInjected,
  BaseQuoteRequestInjected,
  buildQuoteContainerInjected,
  buildQuoteRequestInjected,
  createInjectorLogger,
} from '../shared/quote-injector';
import { PostQuoteRequestBody } from './schema';

export interface ContainerInjected extends BaseQuoteContainerInjected {}

export interface RequestInjected extends BaseQuoteRequestInjected {}

export class QuoteInjector extends ApiInjector<ContainerInjected, RequestInjected, PostQuoteRequestBody, void> {
  public async buildContainerInjected(): Promise<ContainerInjected> {
    const log: Logger = createInjectorLogger(this.injectorName);

    const stage = process.env['stage'];

    // Soft quotes are dispatched per-swapper, so the real compliance list applies: it
    // excludes specific swappers from specific filler endpoints.
    const complianceKey = stage === STAGE.BETA ? BETA_COMPLIANCE_S3_KEY : PROD_COMPLIANCE_S3_KEY;
    const fillerComplianceProvider = new S3FillerComplianceConfigurationProvider(
      log,
      `${COMPLIANCE_CONFIG_BUCKET}-${stage}-1`,
      complianceKey
    );

    return buildQuoteContainerInjected(log, stage, fillerComplianceProvider);
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
