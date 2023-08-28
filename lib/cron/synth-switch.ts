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
import { ethers } from 'ethers';

type TokenConfig = {
  inputToken: string;
  inputTokenChainId: number;
  outputToken: string;
  outputTokenChainId: number;
  tradeTypes: string[];
  tradeSizes: string[]; // inclusive range [lower, upper]
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

  const configs = validateConfigs(await readTokenConfig(log));

  // TODO: this may not be safe from injection but we might need to do it for LOWER
  const tokenInList = "LOWER('" + configs.map((config) => config.inputToken).join("'), LOWER('") + "')";
  const tokenOutList = "LOWER('" + configs.map((config) => config.outputToken).join("'), LOWER('") + "')";

  log.info(
    {
      tokenInList,
      tokenOutList,
      valueTokenInList: String(tokenInList),
      valueTokenOutList: String(tokenOutList),
    },
    'formatted tokenInList, tokenOutList'
  )

  // TODO: get token prices

  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - 60 * 60 * 24 * 7; // 7 days ago

  try {
    const createViewResponse = await client.send(
      new ExecuteStatementCommand({
        ...sharedConfig,
        Sql: TEMPLATE_SYNTH_ORDERS_SQL,
        Parameters: [
          {
            name: 'token_in_list',
            value: String(tokenInList)
          },
          {
            name: 'token_out_list',
            value: String(tokenOutList)
          },
          {
            name: 'start_time',
            value: String(startTime),
          },
          {
            name: 'end_time',
            value: String(endTime)
          },
        ],
      })
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

function validateConfigs(configs: TokenConfig[]) {
  // make sure all tokens are valid addresses
  configs = configs.filter((config) => {
    return ethers.utils.isAddress(config.inputToken) && ethers.utils.isAddress(config.outputToken);
  });

  return configs
}

const TEMPLATE_SYNTH_ORDERS_SQL = `
  WITH syntheticResponses AS (
    SELECT
        tokenin,
        tokeninchainid,
        amountin,
        tokenout,
        tokenoutchainid,
        quoteid
    FROM
        "uniswap_x"."public"."unifiedroutingresponses"
    WHERE routing = 'DUTCH_LIMIT'
    AND filler = ''
    /*
    parameters
    */
    AND LOWER(tokenIn) IN (:token_in_list)
    AND LOWER(tokenOut) IN (:token_out_list)
  )
  SELECT
    sr.tokenin,
    sr.tokeninchainid,
    sr.amountin,
    sr.tokenout,
    sr.tokenoutchainid,
    ao.amountout,
    ao.filler,
    ao.filltimestamp
  FROM
    "uniswap_x"."public"."archivedorders" ao
  JOIN syntheticResponses sr ON ao.quoteid = sr.quoteid
  WHERE ao.orderstatus = 'filled'
  AND ao.filltimestamp BETWEEN :start_time AND :end_time
  ORDER BY ao.filltimestamp DESC;
`;

module.exports = { handler };
