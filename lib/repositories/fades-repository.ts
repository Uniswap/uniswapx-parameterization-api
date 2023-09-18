import { GetStatementResultCommand, RedshiftDataClient } from '@aws-sdk/client-redshift-data';
import Logger from 'bunyan';

import { BaseRedshiftRepository, SharedConfigs } from './base';

export type FadesRowType = {
  fillerAddress: string;
  totalQuotes: number;
  fadedQuotes: number;
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
