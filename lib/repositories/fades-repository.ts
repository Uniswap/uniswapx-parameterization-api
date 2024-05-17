import { GetStatementResultCommand, RedshiftDataClient } from '@aws-sdk/client-redshift-data';
import Logger from 'bunyan';

import { BaseRedshiftRepository, SharedConfigs } from './base';

export type FadesRowType = {
  fillerAddress: string;
  totalQuotes: number;
  fadedQuotes: number;
};

export type V2FadesRowType = {
  fillerAddress: string;
  faded: number;
  postTimestamp: number;
};

export class FadesRepository extends BaseRedshiftRepository {
  static log: Logger;

  static create(configs: SharedConfigs): FadesRepository {
    this.log = Logger.createLogger({
      name: 'FadeRepository',
      serializers: Logger.stdSerializers,
    });

    return new FadesRepository(new RedshiftDataClient({}), configs);
  }

  constructor(readonly client: RedshiftDataClient, configs: SharedConfigs) {
    super(client, configs);
  }

  async createFadesView(): Promise<void> {
    await this.executeStatement(CREATE_VIEW_SQL, FadesRepository.log, { waitTimeMs: 2_000 });
  }

  async getFades(): Promise<FadesRowType[]> {
    const stmtId = await this.executeStatement(FADE_RATE_SQL, FadesRepository.log, { waitTimeMs: 2_000 });
    const response = await this.client.send(new GetStatementResultCommand({ Id: stmtId }));
    /* result should be in the following format
        | rfqFiller    |   fade_rate    |
        |---- foo ------|---- 0.05 ------|
        |---- bar ------|---- 0.01 ------|
      */
    const result = response.Records;
    if (!result) {
      FadesRepository.log.error('no fade rate calculation result');
      throw new Error('No fade rate result');
    }
    const formattedResult = result.map((row) => {
      const formattedRow: FadesRowType = {
        fillerAddress: row[0].stringValue as string,
        totalQuotes: Number(row[1].longValue as number),
        fadedQuotes: Number(row[2].longValue as number),
      };
      return formattedRow;
    });
    FadesRepository.log.info({ result: formattedResult }, 'formatted redshift query result');
    return formattedResult;
  }
}

export class V2FadesRepository extends BaseRedshiftRepository {
  static log: Logger;

  static create(configs: SharedConfigs): V2FadesRepository {
    this.log = Logger.createLogger({
      name: 'V2FadeRepository',
      serializers: Logger.stdSerializers,
    });

    return new V2FadesRepository(new RedshiftDataClient({}), configs);
  }

  constructor(readonly client: RedshiftDataClient, configs: SharedConfigs) {
    super(client, configs);
  }

  async createFadesView(): Promise<void> {
    await this.executeStatement(V2_CREATE_VIEW_SQL, V2FadesRepository.log, { waitTimeMs: 2_000 });
  }

  //get latest 20 orders for each filler address, and whether they are faded or not
  async getFades(): Promise<V2FadesRowType[]> {
    const stmtId = await this.executeStatement(V2_FADE_RATE_SQL, V2FadesRepository.log, { waitTimeMs: 2_000 });
    const response = await this.client.send(new GetStatementResultCommand({ Id: stmtId }));
    /* result should be in the following format
        | rfqFiller    |     faded  |   postTimestamp  |
        |---- bar ------|---- 0 ----|---- 12222222 ----|
        |---- foo ------|---- 1 ----|---- 12345679 ----|
        |---- foo ------|---- 0 ----|---- 12345678 ----|
      */
    const result = response.Records;
    if (!result) {
      V2FadesRepository.log.error('no fade rate calculation result');
      throw new Error('No fade rate result');
    }
    const formattedResult = result.map((row) => {
      const formattedRow: V2FadesRowType = {
        fillerAddress: row[0].stringValue as string,
        postTimestamp: Number(row[1].longValue as number),
        faded: Number(row[2].longValue as number),
      };
      return formattedRow;
    });
    V2FadesRepository.log.info({ result: formattedResult }, 'formatted redshift query result');
    return formattedResult;
  }
}

const CREATE_VIEW_SQL = `
CREATE OR REPLACE VIEW rfqOrdersTimestamp 
AS (
WITH latestOrders AS (
  SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY filler ORDER BY createdat DESC) AS row_num FROM postedorders WHERE ordertype = 'Dutch'
  )
  WHERE row_num <= 30
  AND deadline < EXTRACT(EPOCH FROM GETDATE()) -- exclude orders that can still be filled
)
SELECT
    latestOrders.chainid as chainId, latestOrders.filler as rfqFiller, latestOrders.startTime as decayStartTime, latestOrders.quoteid, archivedorders.filler as actualFiller, latestOrders.createdat as postTimestamp, archivedorders.txhash as txHash, archivedOrders.fillTimestamp as fillTimestamp,
    CASE
      WHEN latestOrders.inputstartamount = latestOrders.inputendamount THEN 'EXACT_INPUT'
      ELSE 'EXACT_OUTPUT'
    END as tradeType
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
        SUM(CASE WHEN (decayStartTime < fillTimestamp) THEN 1 ELSE 0 END) AS fadedQuotes
    FROM rfqOrdersTimestamp
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

const V2_CREATE_VIEW_SQL = `
CREATE OR REPLACE VIEW latestRfqsV2 
AS (
WITH latestOrdersV2 AS (
  SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY filler ORDER BY createdat DESC) AS row_num FROM postedorders WHERE ordertype = 'Dutch_V2'
  )
  WHERE row_num <= 20
  AND deadline < EXTRACT(EPOCH FROM GETDATE()) -- exclude orders that can still be filled
  LIMIT 1000
)
SELECT
    latestOrdersV2.chainid as chainId, latestOrdersV2.filler as rfqFiller, latestOrdersV2.startTime as decayStartTime, latestOrdersV2.quoteid, archivedorders.filler as actualFiller, latestOrdersV2.createdat as postTimestamp, archivedorders.txhash as txHash, archivedOrders.fillTimestamp as fillTimestamp,
    CASE
      WHEN latestOrdersV2.inputstartamount = latestOrdersV2.inputendamount THEN 'EXACT_INPUT'
      ELSE 'EXACT_OUTPUT'
    END as tradeType
FROM
    latestOrdersV2 LEFT OUTER JOIN archivedorders ON latestOrdersV2.quoteid = archivedorders.quoteid
where
rfqFiller IS NOT NULL
AND latestOrdersV2.quoteId IS NOT NULL
AND rfqFiller != '0x0000000000000000000000000000000000000000'
AND chainId NOT IN (5,8001,420,421613) -- exclude mainnet goerli, polygon goerli, optimism goerli and arbitrum goerli testnets 
AND
    postTimestamp >= extract(epoch from (GETDATE() - INTERVAL '48 HOURS')) -- 2 days rolling window
)
ORDER BY rfqFiller, postTimestamp DESC
LIMIT 1000 
`;

const V2_FADE_RATE_SQL = `
SELECT 
    rfqFiller,
    postTimestamp,
    CASE WHEN (decayStartTime < fillTimestamp) THEN 1 ELSE 0 END AS faded
FROM latestRfqsV2
ORDER BY rfqFiller, postTimestamp DESC
LIMIT 1000
`;
