import { GetStatementResultCommand, RedshiftDataClient } from '@aws-sdk/client-redshift-data';
import Logger from 'bunyan';

import { OrderType, PERMISSIONED_TOKENS } from '@uniswap/uniswapx-sdk';
import { BaseRedshiftRepository, SharedConfigs } from './base';

// Most-recent orders per filler evaluated for the fade rate. With the 24h view window the
// lookback is adaptive: a high-volume filler is judged on its latest N orders (fast reaction),
// a low-volume filler on up to 24h of orders (catches chronic fading).
export const ORDERS_PER_FILLER_LIMIT = 100;

// Row cap on the fade view/query. The view emits up to ORDERS_PER_FILLER_LIMIT rows per filler
// address, so total rows ~= (distinct filler addresses in 24h) * ORDERS_PER_FILLER_LIMIT.
// Above the cap, rows are truncated and some fillers escape scoring.
export const FADE_QUERY_ROW_LIMIT = 20000;

export type V2FadesRowType = {
  fillerAddress: string;
  faded: number;
  postTimestamp: number;
  deadline: number; // When the order outcome was finalized
  orderHash: string;
};

/**
 * Computes per-filler fade signals for the circuit breaker. Covers both
 * Dutch_V2 (time-based decay) and Dutch_V3 (block-based decay) orders. Fades are
 * aggregated per filler across all order types and all production chains.
 */
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

  // get each filler address's recent orders (24h window, capped at ORDERS_PER_FILLER_LIMIT) and whether they faded
  async getFades(): Promise<V2FadesRowType[]> {
    const stmtId = await this.executeStatement(V2_FADE_RATE_SQL, V2FadesRepository.log, { waitTimeMs: 2_000 });
    const response = await this.client.send(new GetStatementResultCommand({ Id: stmtId }));
    /* result should be in the following format
        | rfqFiller    |   postTimestamp  |   deadline   |   faded  |   orderHash  |
        |---- bar ------|---- 12222222 ---|--- 12222282 -|---- 0 ---|---- 0xbar ---|
        |---- foo ------|---- 12345679 ---|--- 12345739 -|---- 1 ---|---- 0xfoo ---|
        |---- foo ------|---- 12345678 ---|--- 12345738 -|---- 0 ---|---- 0xbaz ---|
      */
    const result = response.Records;
    if (!result) {
      V2FadesRepository.log.error('no fade rate calculation result');
      throw new Error('No fade rate result');
    }
    const formattedResult = result.map((row) => {
      const formattedRow: V2FadesRowType = {
        // the ordering of the fields has to match that in the sql query
        fillerAddress: row[0].stringValue as string,
        postTimestamp: parseInt(row[1].stringValue as string),
        deadline: parseInt(row[2].stringValue as string),
        faded: Number(row[3].longValue as number),
        orderHash: row[4].stringValue as string,
      };
      return formattedRow;
    });
    V2FadesRepository.log.info({ result: formattedResult }, 'formatted redshift query result');
    return formattedResult;
  }
}

const V2_CREATE_VIEW_SQL = `
DROP VIEW IF EXISTS latestRfqsV2;

CREATE OR REPLACE VIEW latestRfqsV2 
AS (
WITH latestOrdersV2 AS (
  SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY filler ORDER BY createdat DESC) AS row_num FROM postedorders
    WHERE ordertype IN ('${OrderType.Dutch_V2}', '${OrderType.Dutch_V3}')
    AND deadline < EXTRACT(EPOCH FROM GETDATE()) -- completed orders only, BEFORE numbering: in-flight orders must not consume latest-N slots
  )
  WHERE row_num <= ${ORDERS_PER_FILLER_LIMIT}
  LIMIT ${FADE_QUERY_ROW_LIMIT}
)
SELECT
    latestOrdersV2.chainid as chainId, latestOrdersV2.ordertype as orderType, latestOrdersV2.filler as rfqFiller, latestOrdersV2.startTime as decayStartTime, latestOrdersV2.quoteid, latestOrdersV2.orderhash as orderHash, archivedorders.filler as actualFiller, latestOrdersV2.createdat as postTimestamp, latestOrdersV2.deadline as deadline, archivedorders.txhash as txHash, archivedOrders.fillTimestamp as fillTimestamp, archivedorders.fillTimeBlocks as fillTimeBlocks, archivedOrders.tokenIn as tokenIn, archivedOrders.tokenOut as tokenOut,
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
    deadline >= extract(epoch from (GETDATE() - INTERVAL '24 HOURS')) -- 24-hour rolling window based on order completion time; catches chronic low-volume fading
)
ORDER BY rfqFiller, deadline DESC
LIMIT ${FADE_QUERY_ROW_LIMIT} 
`;

const V2_FADE_RATE_SQL = `
SELECT
    rfqFiller,
    postTimestamp,
    deadline,
    -- the parser in getFades() indexes columns by position; keep this ordering in sync
    CASE
      -- Never filled (any order type) => fade.
      WHEN fillTimestamp IS NULL THEN 1
      -- Dutch_V3 decays by block, not by time. fillTimeBlocks is computed
      -- upstream as (fillBlock - decayStartBlock). A fill AT decayStartBlock
      -- (fillTimeBlocks = 0) is still within the exclusive filler's window and
      -- pays the full undecayed price on-chain, so only fills strictly after
      -- decayStartBlock count as fades (matching the Dutch_V2 rule below).
      WHEN orderType = '${OrderType.Dutch_V3}' AND fillTimeBlocks > 0 THEN 1
      -- Dutch_V2 (time-based decay): filled after decay start => fade.
      WHEN orderType = '${OrderType.Dutch_V2}' AND decayStartTime < fillTimestamp THEN 1
      ELSE 0
    END AS faded,
    orderHash
FROM latestRfqsV2
WHERE LOWER(tokenIn) NOT IN (${PERMISSIONED_TOKENS.map((token) => `'${token.address.toLowerCase()}'`).join(',')})
AND LOWER(tokenOut) NOT IN (${PERMISSIONED_TOKENS.map((token) => `'${token.address.toLowerCase()}'`).join(',')})
ORDER BY rfqFiller, deadline DESC
LIMIT ${FADE_QUERY_ROW_LIMIT}
`;
