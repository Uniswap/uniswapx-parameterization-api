import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DescribeStatementCommand,
  ExecuteStatementCommand,
  GetStatementResultCommand,
  RedshiftDataClient,
  StatusString,
} from '@aws-sdk/client-redshift-data';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TradeType } from '@uniswap/sdk-core';
import { MetricLoggerUnit, setGlobalMetric } from '@uniswap/smart-order-router';
import { metricScope, MetricsLogger } from 'aws-embedded-metrics';
import { ScheduledHandler } from 'aws-lambda/trigger/cloudwatch-events';
import { EventBridgeEvent } from 'aws-lambda/trigger/eventbridge';
import { default as bunyan, default as Logger } from 'bunyan';
import { BigNumber, ethers } from 'ethers';

import { PRODUCTION_S3_KEY, SYNTH_SWITCH_BUCKET } from '../constants';
import { AWSMetricsLogger, Metric, metricContext } from '../entities';
import { SynthSwitchQueryParams } from '../handlers/synth-switch';
import { checkDefined } from '../preconditions/preconditions';
import { SwitchRepository } from '../repositories/switch-repository';

export type TokenConfig = {
  tokenIn: string;
  tokenInChainId: number;
  tokenOut: string;
  tokenOutChainId: number;
  tradeTypes: string[];
  lowerBound: string[];
};

type ResultRowType = {
  tokenin: string;
  tokeninchainid: number;
  dutch_amountin: string;
  classic_amountin: string;
  dutch_amountingasadjusted: string;
  classic_amountingasadjusted: string;
  tokenout: string;
  tokenoutchainid: number;
  dutch_amountout: string;
  classic_amountout: string;
  dutch_amountoutgasadjusted: string;
  classic_amountoutgasadjusted: string;
  settledAmountIn: string;
  settledAmountOut: string;
  filler: string;
  filltimestamp: string;
};

type TradeOutcome = {
  pos: number;
  neg: number;
};

const MINIMUM_ORDERS = 5;
const DISABLE_THRESHOLD = 0.2;

export const handler: ScheduledHandler = metricScope(
  (metricsLogger) => async (_event: EventBridgeEvent<string, void>) => {
    await main(metricsLogger);
  }
);

async function main(metricsLogger: MetricsLogger) {
  metricsLogger.setNamespace('Uniswap');
  metricsLogger.setDimensions({
    Service: 'SyntheticSwitch',
  });
  const metrics = new AWSMetricsLogger(metricsLogger);
  setGlobalMetric(metrics);

  const log: Logger = bunyan.createLogger({
    name: 'SynthPairsCron',
    serializers: bunyan.stdSerializers,
    level: 'info',
  });

  const client = new RedshiftDataClient({});
  const synthSwitchEntity = SwitchRepository.create(
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: {
        convertEmptyValues: true,
      },
      unmarshallOptions: {
        wrapNumbers: true,
      },
    })
  );

  const sharedConfig = {
    Database: process.env.REDSHIFT_DATABASE,
    ClusterIdentifier: process.env.REDSHIFT_CLUSTER_IDENTIFIER,
    SecretArn: process.env.REDSHIFT_SECRET_ARN,
  };

  log.info({ config: sharedConfig }, 'sharedConfig');

  let stmtId: string | undefined;

  const configs = validateConfigs(await readTokenConfig(log));

  // We can't pass in arrays as parameters to the query, so we have to build it into a formatted string
  // tokenIn and tokenOut MUST be sanitized and lowercased before being passed into the query
  const tokenInListRaw = Array.from(new Set(configs.map((config) => config.tokenIn)));
  const tokenOutListRaw = Array.from(new Set(configs.map((config) => config.tokenOut)));
  const tokenInList = "('" + tokenInListRaw.join("', '") + "')";
  const tokenOutList = "('" + tokenOutListRaw.join("', '") + "')";

  // TODO: WHERE in may have performance issues as num records increases
  // potentially filter the tokens in the cron instead
  const FORMATTED_SYNTH_ORDERS_AND_URA_RESPONSES_SQL = `
    SELECT
            res.tokenin,
            res.tokeninchainid,
            dutch_amountin,
            classic_amountin,
            dutch_amountingasadjusted,
            classic_amountingasadjusted,
            res.tokenout,
            res.tokenoutchainid,
            dutch_amountout,
            classic_amountout,
            dutch_amountoutgasadjusted,
            classic_amountoutgasadjusted,
            orders.amountin as settledAmountIn,
            orders.amountout as settledAmountOut,
            filler,
            filltimestamp
    FROM archivedorders orders
    JOIN combinedURAResponses res
    ON orders.quoteid = res.quoteid
    ${
      tokenInListRaw.length > 0 && tokenOutListRaw.length > 0
        ? `WHERE LOWER(res.tokenin) IN ${tokenInList} AND LOWER(res.tokenout) IN ${tokenOutList}`
        : ''
    }
    ORDER by filltimestamp DESC;
  `;

  function hasPositiveTradeOutcome(order: ResultRowType): {
    key: string;
    result: boolean;
  } {
    const tradeType =
      order.classic_amountin == order.classic_amountingasadjusted ? TradeType.EXACT_INPUT : TradeType.EXACT_OUTPUT;
    const trade: SynthSwitchQueryParams = {
      tokenIn: order.tokenin,
      tokenInChainId: order.tokeninchainid,
      tokenOut: order.tokenout,
      tokenOutChainId: order.tokenoutchainid,
      type: TradeType[tradeType],
      amount: tradeType == TradeType.EXACT_INPUT ? order.classic_amountin : order.classic_amountout,
    };
    const key = SwitchRepository.getKey(trade);
    let hasPriceImprovement: boolean;
    if (tradeType == TradeType.EXACT_INPUT) {
      hasPriceImprovement = BigNumber.from(order.settledAmountOut).gt(order.classic_amountoutgasadjusted);
      log.info(
        {
          type: TradeType[tradeType],
          order,
          hasPriceImprovement,
          settledAmountOut: order.settledAmountOut,
          classic_amountoutgasadjusted: order.classic_amountoutgasadjusted,
          priceImprovementBps: hasPriceImprovement
            ? BigNumber.from(order.settledAmountOut).div(order.classic_amountoutgasadjusted).toString()
            : BigNumber.from(order.classic_amountoutgasadjusted).div(order.settledAmountOut).toString(),
        },
        'trade outcome'
      );
    } else {
      hasPriceImprovement = BigNumber.from(order.classic_amountingasadjusted).gt(order.settledAmountIn);
      log.info(
        {
          type: TradeType[tradeType],
          order,
          hasPriceImprovement,
          settledAmountIn: order.settledAmountIn,
          classic_amountingasadjusted: order.classic_amountingasadjusted,
          priceImprovementBps: hasPriceImprovement
            ? BigNumber.from(order.classic_amountingasadjusted).div(order.settledAmountIn).toString()
            : BigNumber.from(order.settledAmountIn).div(order.classic_amountingasadjusted).toString(),
        },
        'trade outcome'
      );
    }
    // can add more conditionals here
    const result = hasPriceImprovement;
    return { key, result };
  }

  async function updateSynthSwitchRepository(
    configs: TokenConfig[],
    result: ResultRowType[],
    metrics: AWSMetricsLogger
  ) {
    const beforeOrdersProcessing = Date.now();
    // match configs to results
    const configMap: {
      [key: string]: ResultRowType[];
    } = {};
    result.map((row) => {
      const key = `${row.tokenin}#${row.tokeninchainid}#${row.tokenout}#${row.tokenoutchainid}`;
      if (key in configMap) {
        configMap[key].push(row);
      } else {
        configMap[key] = [row];
      }
    });

    for (const config of configs) {
      const ordersForConfig =
        configMap[
          `${config.tokenIn.toLowerCase()}#${config.tokenInChainId}#${config.tokenOut.toLowerCase()}#${
            config.tokenOutChainId
          }`
        ];

      if (!ordersForConfig) {
        // no orders for that config, skip
        continue;
      }

      const tradeOutcomesByKey = ordersForConfig.reduce(
        (acc, order) => {
          const { key, result } = hasPositiveTradeOutcome(order);
          acc[key] = acc[key] || { pos: 0, neg: 0 };
          result ? acc[key].pos++ : acc[key].neg++;
          return acc;
        },
        {} as {
          [key: string]: TradeOutcome;
        }
      );

      Object.keys(tradeOutcomesByKey).forEach(async (key) => {
        const { pos, neg } = tradeOutcomesByKey[key];
        const totalOrders = pos + neg;
        log.info(
          {
            key,
            ordersWithNegativeOutcome: neg,
            ordersWithPositiveOutcome: pos,
            totalOrders,
          },
          'Outcome for trade'
        );
        metrics.putMetric(Metric.SYNTH_ORDERS_POSITIVE_OUTCOME, pos, MetricLoggerUnit.Count);
        metrics.putMetric(metricContext(Metric.SYNTH_ORDERS_POSITIVE_OUTCOME, key), pos, MetricLoggerUnit.Count);
        metrics.putMetric(Metric.SYNTH_ORDERS_NEGATIVE_OUTCOME, neg, MetricLoggerUnit.Count);
        metrics.putMetric(metricContext(Metric.SYNTH_ORDERS_NEGATIVE_OUTCOME, key), neg, MetricLoggerUnit.Count);

        const enabled = await synthSwitchEntity.syntheticQuoteForTradeEnabled({
          ...SwitchRepository.parseKey(key),
          amount: config.lowerBound[0],
        });

        if (totalOrders >= MINIMUM_ORDERS && neg / totalOrders >= DISABLE_THRESHOLD && enabled) {
          // disable synth
          log.info(
            {
              key,
              totalOrders,
              negPIRate: neg / totalOrders,
            },
            `[Disabling] ${key} - neg PI rate: ${
              neg / totalOrders
            } >= ${DISABLE_THRESHOLD}; totalOrders: ${totalOrders} >= ${MINIMUM_ORDERS}`
          );
          try {
            await synthSwitchEntity.putSynthSwitch(SwitchRepository.parseKey(key), config.lowerBound[0], false);
            metrics.putMetric(Metric.SYNTH_PAIR_DISABLED, 1, MetricLoggerUnit.Count);
            metrics.putMetric(metricContext(Metric.SYNTH_PAIR_DISABLED, key), 1, MetricLoggerUnit.Count);
            return;
          } catch (e) {
            log.error({ key, error: e }, 'Failed to disable synthethics for trade');
            metrics.putMetric(metricContext(Metric.DYNAMO_REQUEST_ERROR, 'disable_synth'), 1, MetricLoggerUnit.Count);
          }
        }
        if (pos > 0 && !enabled) {
          log.info(
            {
              key,
              totalOrders,
              positivePIOrders: pos,
            },
            `[Enabling] ${key} - positive PI orders: ${pos} > 0; totalOrders: ${totalOrders} >= ${MINIMUM_ORDERS}`
          );
          try {
            await synthSwitchEntity.putSynthSwitch(SwitchRepository.parseKey(key), config.lowerBound[0], true);
            metrics.putMetric(Metric.SYTH_PAIR_ENABLED, 1, MetricLoggerUnit.Count);
            metrics.putMetric(metricContext(Metric.SYTH_PAIR_ENABLED, key), 1, MetricLoggerUnit.Count);
          } catch (e) {
            log.error({ key, error: e }, 'Failed to enable synthethics for trade');
            metrics.putMetric(metricContext(Metric.DYNAMO_REQUEST_ERROR, 'enable_synth'), 1, MetricLoggerUnit.Count);
          }
        }
      });
    }
    metrics.putMetric(
      Metric.SYNTH_ORDERS_PROCESSING_TIME,
      Date.now() - beforeOrdersProcessing,
      MetricLoggerUnit.Milliseconds
    );
  }

  // create view
  const beforeViewCreation = Date.now();
  try {
    metrics.putMetric(metricContext(Metric.DYNAMO_REQUEST, 'view_creation'), 1, MetricLoggerUnit.Count);
    const createViewResponse = await client.send(
      new ExecuteStatementCommand({ ...sharedConfig, Sql: CREATE_COMBINED_URA_RESPONSES_VIEW_SQL })
    );
    stmtId = createViewResponse.Id;
  } catch (e) {
    log.error({ error: e }, 'Failed to send create view command');
    metrics.putMetric(metricContext(Metric.DYNAMO_REQUEST_ERROR, 'view_network'), 1, MetricLoggerUnit.Count);
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
      metrics.putMetric(metricContext(Metric.DYNAMO_REQUEST_ERROR, 'view_status'), 1, MetricLoggerUnit.Count);
      throw new Error(status.Error);
    } else if (
      status.Status === StatusString.PICKED ||
      status.Status === StatusString.STARTED ||
      status.Status === StatusString.SUBMITTED
    ) {
      await sleep(2000);
    } else if (status.Status === StatusString.FINISHED) {
      log.info('view query execution finished');
      metrics.putMetric(
        Metric.SYNTH_ORDERS_VIEW_CREATION_TIME,
        Date.now() - beforeViewCreation,
        MetricLoggerUnit.Milliseconds
      );
      break;
    } else {
      log.error({ error: status.Error }, 'Unknown status');
      metrics.putMetric(metricContext(Metric.DYNAMO_REQUEST_ERROR, 'view_unknown'), 1, MetricLoggerUnit.Count);
      throw new Error(status.Error);
    }
  }

  const beforeOrdersQuery = Date.now();
  try {
    metrics.putMetric(metricContext(Metric.DYNAMO_REQUEST, 'synth_orders'), 1, MetricLoggerUnit.Count);
    const executeResponse = await client.send(
      new ExecuteStatementCommand({
        ...sharedConfig,
        Sql: FORMATTED_SYNTH_ORDERS_AND_URA_RESPONSES_SQL,
      })
    );
    stmtId = executeResponse.Id;
  } catch (e) {
    log.error({ error: e }, 'Failed to send command');
    metrics.putMetric(metricContext(Metric.DYNAMO_REQUEST_ERROR, 'orders_network'), 1, MetricLoggerUnit.Count);
    throw e;
  }
  for (;;) {
    const status = await client.send(new DescribeStatementCommand({ Id: stmtId }));
    if (status.Error || status.Status === StatusString.ABORTED || status.Status === StatusString.FAILED) {
      log.error({ error: status.Error, status: status.Status }, 'Failed to execute query');
      metrics.putMetric(metricContext(Metric.DYNAMO_REQUEST_ERROR, 'orders_status'), 1, MetricLoggerUnit.Count);
      throw new Error(status.Error);
    } else if (
      status.Status === StatusString.PICKED ||
      status.Status === StatusString.STARTED ||
      status.Status === StatusString.SUBMITTED
    ) {
      await sleep(2000);
    } else if (status.Status === StatusString.FINISHED) {
      const getResultResponse = await client.send(new GetStatementResultCommand({ Id: stmtId }));
      metrics.putMetric(Metric.SYNTH_ORDERS_QUERY_TIME, Date.now() - beforeOrdersQuery, MetricLoggerUnit.Milliseconds);

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
      log.info({ numResults: result.length }, 'Retrieved query result');

      if (result.length == 0) {
        log.info('No synthetic orders found for specified configs');
        return;
      }

      const formattedResult = result.map((row) => {
        const formattedRow: ResultRowType = {
          tokenin: (row[0].stringValue as string).toLowerCase(),
          tokeninchainid: row[1].longValue as number,
          dutch_amountin: row[2].stringValue as string,
          classic_amountin: row[3].stringValue as string,
          dutch_amountingasadjusted: row[4].stringValue as string,
          classic_amountingasadjusted: row[5].stringValue as string,
          tokenout: (row[6].stringValue as string).toLowerCase(),
          tokenoutchainid: row[7].longValue as number,
          dutch_amountout: row[8].stringValue as string,
          classic_amountout: row[9].stringValue as string,
          dutch_amountoutgasadjusted: row[10].stringValue as string,
          classic_amountoutgasadjusted: row[11].stringValue as string,
          settledAmountIn: row[12].stringValue as string,
          settledAmountOut: row[13].stringValue as string,
          filler: (row[14].stringValue as string).toLowerCase(),
          filltimestamp: row[15].stringValue as string,
        };
        return formattedRow;
      });
      metrics.putMetric(Metric.SYNTH_ORDERS, formattedResult.length, MetricLoggerUnit.Count);
      await updateSynthSwitchRepository(configs, formattedResult, metrics);
      break;
    } else {
      log.error({ error: status.Error }, 'Unknown status');
      metrics.putMetric(metricContext(Metric.DYNAMO_REQUEST_ERROR, 'orders_unknown'), 1, MetricLoggerUnit.Count);
      throw new Error(status.Error);
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readTokenConfig(log: Logger): Promise<TokenConfig[]> {
  const s3Client = new S3Client({});
  const stage = process.env['stage'];
  const s3Res = await s3Client.send(
    new GetObjectCommand({
      Bucket: `${SYNTH_SWITCH_BUCKET}-${stage}-1`,
      Key: PRODUCTION_S3_KEY,
    })
  );
  const s3Body = checkDefined(s3Res.Body, 's3Res.Body is undefined');
  const configs = JSON.parse(await s3Body.transformToString()) as TokenConfig[];

  log.info({ tokenConfigs: configs }, 'Fetched token configs from S3');
  return configs;
}

export function validateConfigs(configs: TokenConfig[]) {
  // make sure all tokens are valid addresses
  configs = configs.filter((config) => {
    return ethers.utils.isAddress(config.tokenIn) && ethers.utils.isAddress(config.tokenOut);
  });

  // normalize token addresses
  configs = configs.map((config) => {
    return {
      ...config,
      tokenIn: ethers.utils.getAddress(config.tokenIn).toLowerCase(),
      tokenOut: ethers.utils.getAddress(config.tokenOut).toLowerCase(),
    };
  });

  return configs;
}

const CREATE_COMBINED_URA_RESPONSES_VIEW_SQL = `
  CREATE OR REPLACE VIEW combinedURAResponses AS
  (
      WITH synth AS (
          SELECT
              *
          FROM
              "uniswap_x"."public"."unifiedroutingresponses"
          WHERE routing = 'DUTCH_LIMIT'
          AND filler = '0x0000000000000000000000000000000000000000'
      )
      select
              synth.createdat,
              synth.quoteid,
              synth.tokenin,
              synth.tokeninchainid,
              synth.amountin AS dutch_amountin,
              ur.amountin as classic_amountin,
              synth.amountingasadjusted as dutch_amountingasadjusted,
              ur.amountingasadjusted as classic_amountingasadjusted,
              synth.tokenout,
              synth.tokenoutchainid,
              synth.amountout as dutch_amountout,
              ur.amountout as classic_amountout,
              synth.amountoutgasadjusted as dutch_amountoutgasadjusted,
              ur.amountoutgasadjusted as classic_amountoutgasadjusted
          from synth
          join "uniswap_x"."public"."unifiedroutingresponses" ur
          on ur.requestid = synth.requestid and ur.quoteid != synth.quoteid
          WHERE synth.createdat >= extract(epoch from (GETDATE() - INTERVAL '12 HOURS')) -- 12 hours rolling window
  );
`;
