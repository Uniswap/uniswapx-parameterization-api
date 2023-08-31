import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DescribeStatementCommand,
  ExecuteStatementCommand,
  GetStatementResultCommand,
  RedshiftDataClient,
  StatusString,
} from '@aws-sdk/client-redshift-data';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ScheduledHandler } from 'aws-lambda/trigger/cloudwatch-events';
import { EventBridgeEvent } from 'aws-lambda/trigger/eventbridge';
import { default as bunyan, default as Logger } from 'bunyan';
import { Entity, Table } from 'dynamodb-toolbox';

import { DYNAMO_TABLE_KEY, DYNAMO_TABLE_NAME } from '../constants';

const handler: ScheduledHandler = async (_event: EventBridgeEvent<string, void>) => {
  const log: Logger = bunyan.createLogger({
    name: 'FadeRateCron',
    serializers: bunyan.stdSerializers,
    level: 'info',
  });

  const client = new RedshiftDataClient({});
  const fadeRateEntity = createDynamoEntity();

  const sharedConfig = {
    Database: process.env.REDSHIFT_DATABASE,
    ClusterIdentifier: process.env.REDSHIFT_CLUSTER_IDENTIFIER,
    SecretArn: process.env.REDSHIFT_SECRET_ARN,
  };

  log.info({ config: sharedConfig }, 'sharedConfig');

  let stmtId: string | undefined;

  // create view
  try {
    const createViewResponse = await client.send(
      new ExecuteStatementCommand({ ...sharedConfig, Sql: CREATE_VIEW_SQL })
    );
    stmtId = createViewResponse.Id;
  } catch (e) {
    log.error({ error: e }, 'Failed to send create view command');
    throw e;
  }
  for (;;) {
    const status = await client.send(new DescribeStatementCommand({ Id: stmtId }));
    if (status.Error) {
      log.error({ error: status.Error }, 'Failed to create view');
      throw new Error(status.Error);
    }
    if (status.Status === StatusString.ABORTED || status.Status === StatusString.FAILED) {
      log.error({ error: status.Error }, 'Failed to execute create view command');
      throw new Error(status.Error);
    } else if (
      status.Status === StatusString.PICKED ||
      status.Status === StatusString.STARTED ||
      status.Status === StatusString.SUBMITTED
    ) {
      await sleep(2000);
    } else if (status.Status === StatusString.FINISHED) {
      break;
    } else {
      log.error({ error: status.Error }, 'Unknown status');
      throw new Error(status.Error);
    }
  }

  // compute fade rate of each rfq quoter
  try {
    const executeResponse = await client.send(new ExecuteStatementCommand({ ...sharedConfig, Sql: FADE_RATE_SQL }));
    stmtId = executeResponse.Id;
  } catch (e) {
    log.error({ error: e }, 'Failed to send fade rate calc command');
    throw e;
  }
  for (;;) {
    const status = await client.send(new DescribeStatementCommand({ Id: stmtId }));
    if (status.Error) {
      log.error({ error: status.Error }, 'Failed to compute fade rate');
      throw new Error(status.Error);
    }
    if (status.Status === StatusString.ABORTED || status.Status === StatusString.FAILED) {
      log.error({ error: status.Error }, 'Failed to execute fade rate calc command');
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
        | rfqFiller    |   fade_rate    |
        |---- foo ------|---- 0.05 ------|
        |---- bar ------|---- 0.01 ------|
      */
      const result = getResultResponse.Records;
      if (!result) {
        log.error('no fade rate calculation result');
        throw new Error('No fade rate result');
      }
      log.info({ result }, 'fade rate result');
      result.forEach(async (row) => {
        try {
          const res = await fadeRateEntity.put(
            {
              filler: row[0].stringValue ?? '',
              faderate: parseFloat(row[1].stringValue ?? ''),
            },
            {
              execute: true,
            }
          );
          log.info({ res }, 'fade rate put result');
        } catch (e) {
          log.error({ error: e }, 'Failed to put fade rate');
          throw e;
        }
      });
      break;
    }
  }
};

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createDynamoEntity() {
  const DocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: {
      convertEmptyValues: true,
    },
    unmarshallOptions: {
      wrapNumbers: true,
    },
  });

  const table = new Table({
    name: DYNAMO_TABLE_NAME.FADES,
    partitionKey: DYNAMO_TABLE_KEY.FILLER,
    DocumentClient,
  });

  return new Entity({
    name: `${DYNAMO_TABLE_NAME.FADES}Entity`,
    attributes: {
      filler: { partitionKey: true, type: 'string' },
      faderate: { type: 'number' },
    },
    table: table,
    autoExecute: true,
  } as const);
}

const CREATE_VIEW_SQL = `
CREATE OR REPLACE VIEW rfqOrders 
AS (
WITH latestOrders AS (
  SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY filler ORDER BY createdat DESC) AS row_num FROM postedorders
  )
  WHERE row_num <= 20
)
SELECT
    latestOrders.chainid as chainId, latestOrders.filler as rfqFiller, latestOrders.quoteid, archivedorders.filler as actualFiller, latestOrders.createdat as postTimestamp, archivedorders.txhash as txHash,
    CASE
      WHEN latestOrders.inputstartamount = latestOrders.inputendamount THEN 'EXACT_INPUT'
      ELSE 'EXACT_OUTPUT'
    END as tradeType, 
    CASE
      WHEN latestOrders.inputstartamount = latestOrders.inputendamount THEN latestOrders.outputstartamount
      ELSE latestOrders.inputstartamount
    END as quotedAmount,
    archivedorders.amountout as filledAmount
FROM
    latestOrders LEFT OUTER JOIN archivedorders ON latestOrders.quoteid = archivedorders.quoteid
where
rfqFiller IS NOT NULL
AND latestOrders.quoteId IS NOT NULL
AND rfqFiller != '0x0000000000000000000000000000000000000000'
AND chainId NOT IN (5,8001,420,421613) -- exclude mainnet goerli, polygon goerli, optimism goerli and arbitrum goerli testnets 
AND
    postTimestamp >= extract(epoch from (GETDATE() - INTERVAL '168 HOURS')) -- 7 days rolling window
);
`;

const FADE_RATE_SQL = `
WITH ORDERS_CTE AS (
    SELECT 
        rfqFiller,
        COUNT(*) AS totalQuotes,
        SUM(CASE WHEN (tradeType = 'EXACT_INPUT' AND quotedAmount > filledAmount) OR (tradeType = 'EXACT_OUTPUT' AND quotedAmount < filledAmount) THEN 1 ELSE 0 END) AS fadedQuotes
    FROM rfqOrders 
    GROUP BY rfqFiller
)
SELECT 
    rfqFiller,
    totalQuotes,
    fadedQuotes,
    fadedQuotes / totalQuotes as fadeRate
FROM ORDERS_CTE
WHERE totalQuotes >= 10;
`;

module.exports = { handler };
