import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { MetricsLogger, Unit } from 'aws-embedded-metrics';
import Logger from 'bunyan';

import { CircuitBreakerConfiguration, CircuitBreakerConfigurationProvider } from '.';
import { Metric } from '../../entities';
import { checkDefined } from '../../preconditions/preconditions';
import { WebhookConfiguration } from '../webhook';

export class S3CircuitBreakerConfigurationProvider implements CircuitBreakerConfigurationProvider {
  private log: Logger;
  private fillers: CircuitBreakerConfiguration[];
  private lastUpdatedTimestamp: number;
  allow_list: Set<string>;

  // try to refetch endpoints every 5 mins
  private static UPDATE_PERIOD_MS = 5 * 60000;
  private static FILL_RATE_THRESHOLD = 0.75;

  constructor(
    _log: Logger,
    private bucket: string,
    private key: string,
    _allow_list: Set<string> = new Set<string>([])
  ) {
    this.log = _log.child({ quoter: 'S3CircuitBreakerConfigurationProvider' });
    this.fillers = [];
    this.lastUpdatedTimestamp = Date.now();
    this.allow_list = _allow_list;
  }

  async getEligibleEndpoints(endpoints: WebhookConfiguration[]): Promise<WebhookConfiguration[]> {
    try {
      const config = await this.getConfigurations();
      const fillerToConfigMap = new Map(config.map((c) => [c.hash, c]));
      if (config) {
        this.log.info(
          { fillerToCMap: [...fillerToConfigMap.entries()], config: config },
          `Circuit breaker config used`
        );
        const enabledEndpoints: WebhookConfiguration[] = [];
        endpoints.forEach((e) => {
          if (
            this.allow_list.has(e.hash) ||
            (fillerToConfigMap.has(e.hash) && fillerToConfigMap.get(e.hash)?.enabled) ||
            !fillerToConfigMap.has(e.hash) // default to allowing fillers not in the config
          ) {
            this.log.info({ endpoint: e }, `Endpoint enabled`);
            enabledEndpoints.push(e);
          }
        });
        return enabledEndpoints;
      }

      return endpoints;
    } catch (e) {
      this.log.error({ error: e }, `Error getting eligible endpoints, default to returning all`);
      return endpoints;
    }
  }

  async getConfigurations(): Promise<CircuitBreakerConfiguration[]> {
    if (
      this.fillers.length === 0 ||
      Date.now() - this.lastUpdatedTimestamp > S3CircuitBreakerConfigurationProvider.UPDATE_PERIOD_MS
    ) {
      await this.fetchConfigurations();
      this.lastUpdatedTimestamp = Date.now();
    }
    return this.fillers;
  }

  async fetchConfigurations(): Promise<void> {
    try {
      const client = new S3Client({
        requestHandler: new NodeHttpHandler({
          requestTimeout: 500,
        }),
      });
      const s3Res = await client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.key,
        })
      );
      const s3Body = checkDefined(s3Res.Body, 's3Res.Body is undefined');
      this.fillers = JSON.parse(await s3Body.transformToString()) as CircuitBreakerConfiguration[];
      this.log.info({ config: this.fillers }, 'fetched circuit breaker config from S3');
    } catch (e: any) {
      this.log.error(
        { name: e.name, message: e.message },
        'error fetching circuit breaker config from S3; default to allowing all'
      );
    }
  }

  async putConfigurations(fillRates: Map<string, number>, metrics: MetricsLogger): Promise<void> {
    const config: CircuitBreakerConfiguration[] = [];
    for (const [filler, rate] of fillRates) {
      if (rate >= S3CircuitBreakerConfigurationProvider.FILL_RATE_THRESHOLD) {
        metrics.putMetric(Metric.CIRCUIT_BREAKER_TRIGGERED, 1, Unit.Count);
        this.log.info(`circuit breaker triggered for ${filler} at fill rate ${rate}`);
      }
      config.push({
        hash: filler,
        fadeRate: rate,
        // enabled endpoints will be able to participate in RFQ
        enabled: rate < S3CircuitBreakerConfigurationProvider.FILL_RATE_THRESHOLD,
      });
    }
    const client = new S3Client({
      requestHandler: new NodeHttpHandler({
        requestTimeout: 500,
      }),
    });
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
        Body: JSON.stringify(config),
      })
    );
  }
}
