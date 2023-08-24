import {
  DescribeStatementCommand,
  ExecuteStatementCommand,
  GetStatementResultCommand,
  RedshiftDataClient,
  StatusString,
} from '@aws-sdk/client-redshift-data';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ScheduledHandler } from 'aws-lambda/trigger/cloudwatch-events';
import { EventBridgeEvent } from 'aws-lambda/trigger/eventbridge';
import { default as bunyan, default as Logger } from 'bunyan';

import { PRODUCTION_S3_KEY, SYNTH_SWITCH_BUCKET } from '../constants';
import { checkDefined } from '../preconditions/preconditions';

type TokenConfig = {
  inputToken: string;
  outputToken: string;
  tradeTypes: string[];
  tradeSizes: string[];
};

const handler: ScheduledHandler = async (_event: EventBridgeEvent<string, void>) => {
  const log: Logger = bunyan.createLogger({
    name: 'SynthPairsCron',
    serializers: bunyan.stdSerializers,
    level: 'info',
  });

  const client = new RedshiftDataClient({});

  const sharedConfig = {
    Database: process.env.REDSHIFT_DATABASE,
    ClusterIdentifier: process.env.REDSHIFT_CLUSTER_IDENTIFIER,
    SecretArn: process.env.REDSHIFT_SECRET_ARN,
  };

  log.info({ config: sharedConfig }, 'sharedConfig');

  let stmtId: string | undefined;

  const configs = await readTokenConfig(log);
  // TODO: format sql query string with configs

  try {
    const createViewResponse = await client.send(
      new ExecuteStatementCommand({ ...sharedConfig, Sql: fillMetricsSql(configs) })
    );
    stmtId = createViewResponse.Id;
  } catch (e) {
    log.error({ error: e }, 'Failed to send command');
    throw e;
  }
  for (;;) {
    const status = await client.send(new DescribeStatementCommand({ Id: stmtId }));
    if (status.Error || status.Status === StatusString.ABORTED || status.Status === StatusString.FAILED) {
      log.error({ error: status.Error, status: status.Status }, 'Failed to execute query');
      throw new Error(status.Error);
    } else if (
      status.Status === StatusString.PICKED ||
      status.Status === StatusString.STARTED ||
      status.Status === StatusString.SUBMITTED
    ) {
      await sleep(2000);
    } else if (status.Status === StatusString.FINISHED) {
      const getResultResponse = await client.send(new GetStatementResultCommand({ Id: stmtId }));

      /* result should be in the following format
        | column1     |   column2    | * not in the actual result object
        |---- foo ----|---- 1234 ----|
        |---- bar ----|---- 5678 ----|
      */
      const result = getResultResponse.Records;
      if (!result) {
        log.error('empty query result');
        throw new Error('empty query result');
      }
      log.info({ result }, 'query result');
      // TODO: write result to a dynamo table
      break;
    } else {
      log.error({ error: status.Error }, 'Unknown status');
      throw new Error(status.Error);
    }
  }
};

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readTokenConfig(log: Logger): Promise<TokenConfig[]> {
  const s3Client = new S3Client({});
  const s3Res = await s3Client.send(
    new GetObjectCommand({
      Bucket: SYNTH_SWITCH_BUCKET,
      Key: PRODUCTION_S3_KEY,
    })
  );
  const s3Body = checkDefined(s3Res.Body, 's3Res.Body is undefined');
  const configs = JSON.parse(await s3Body.transformToString()) as TokenConfig[];

  log.info({ tokenConfigs: configs }, 'Fetched token configs from S3');
  return configs;
}

function fillMetricsSql(_configs: TokenConfig[]) {
  // TODO: implement
  return 'select * from archivedorders limit 10';
}

module.exports = { handler };
