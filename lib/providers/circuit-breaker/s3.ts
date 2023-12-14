import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { MetricsLogger, Unit } from 'aws-embedded-metrics';
import Logger from 'bunyan';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CircuitBreakerConfiguration, CircuitBreakerConfigurationProvider } from '.';
import { Metric } from '../../entities';
import { checkDefined } from '../../preconditions/preconditions';
import { BaseTimestampRepository } from '../../repositories';
import { TimestampRepository } from '../../repositories/timestamp-repository';

export class S3CircuitBreakerConfigurationProvider implements CircuitBreakerConfigurationProvider {
  private log: Logger;
  private fillers: CircuitBreakerConfiguration[];
  private lastUpdatedTimestamp: number;
  private client: S3Client;
  private timestampDB: BaseTimestampRepository;

  // try to refetch endpoints every minute
  private static UPDATE_PERIOD_MS = 1 * 60000;

  constructor(_log: Logger, private bucket: string, private key: string) {
    this.log = _log.child({ quoter: 'S3CircuitBreakerConfigurationProvider' });
    this.fillers = [];
    this.lastUpdatedTimestamp = Date.now();
    this.client = new S3Client({
      requestHandler: new NodeHttpHandler({
        requestTimeout: 500,
      }),
    });
    const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: {
        convertEmptyValues: true,
      },
      unmarshallOptions: {
        wrapNumbers: true,
      },
    });
    this.timestampDB = TimestampRepository.create(documentClient);
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
    const s3Res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
      })
    );
    const s3Body = checkDefined(s3Res.Body, 's3Res.Body is undefined');
    this.fillers = JSON.parse(await s3Body.transformToString()) as CircuitBreakerConfiguration[];
    this.log.info({ config: this.fillers }, 'fetched circuit breaker config from S3');
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
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
        Body: JSON.stringify(config),
      })
    );
  }
}
