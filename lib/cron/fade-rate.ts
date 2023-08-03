import {
  DescribeStatementCommand,
  ExecuteStatementCommand,
  GetStatementResultCommand,
  RedshiftDataClient,
  StatusString,
} from '@aws-sdk/client-redshift-data';
import { ScheduledHandler } from 'aws-lambda/trigger/cloudwatch-events';
import { EventBridgeEvent } from 'aws-lambda/trigger/eventbridge';
import { default as bunyan, default as Logger } from 'bunyan';

const handler: ScheduledHandler = async (_event: EventBridgeEvent<string, void>) => {
  const log: Logger = bunyan.createLogger({
    name: 'FadeRateCron',
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
      console.log(result);
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

const CREATE_VIEW_SQL = `
CREATE OR REPLACE VIEW rfqOrders 
AS
SELECT
    archivedorders.quoteid as quoteId, archivedorders.filler as actualFiller, archivedorders.filltimestamp as fillTimestamp, archivedorders.txhash as txHash, rfqresponses.filler as rfqFiller
FROM
    archivedorders, rfqresponses
WHERE archivedorders.quoteid = rfqresponses.quoteid
AND rfqFiller IS NOT NULL
AND rfqFiller != '0x0000000000000000000000000000000000000000'
AND
    fillTimestamp >= extract(epoch from (GETDATE() - INTERVAL '24 HOURS'));
`;

const FADE_RATE_SQL = `
WITH ORDERS_CTE AS (
    SELECT 
        rfqFiller,
        COUNT(*) AS TotalFills,
        SUM(CASE WHEN rfqFiller != actualFiller THEN 1 ELSE 0 END) AS UnmatchedFills
    FROM rfqOrders 
    GROUP BY rfqFiller
)
SELECT 
    rfqFiller,
    (UnmatchedFills::decimal / TotalFills) AS Fade_Rate
FROM ORDERS_CTE;
`;

module.exports = { handler };
