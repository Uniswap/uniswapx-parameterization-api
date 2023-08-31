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
import { ScheduledHandler } from 'aws-lambda/trigger/cloudwatch-events';
import { EventBridgeEvent } from 'aws-lambda/trigger/eventbridge';
import { default as bunyan, default as Logger } from 'bunyan';
import { BigNumber, ethers } from 'ethers';

import { PRODUCTION_S3_KEY, SYNTH_SWITCH_BUCKET } from '../constants';
import { SynthSwitchQueryParams } from '../handlers/synth-switch';
import { checkDefined } from '../preconditions/preconditions';
import { SwitchRepository } from '../repositories/switch-repository';

type TokenConfig = {
  inputToken: string;
  inputTokenChainId: number;
  outputToken: string;
  outputTokenChainId: number;
  tradeTypes: string[];
  tradeSizes: string[]; // inclusive range [lower, upper]
};

type ResultRowType = {
  tokenin: string;
  tokeninchainid: string;
  dutch_amountin: string;
  classic_amountin: string;
  dutch_amountingasadjusted: string;
  classic_amountingasadjusted: string;
  tokenout: string;
  tokenoutchainid: string;
  dutch_amountout: string;
  classic_amountout: string;
  dutch_amountoutgasadjusted: string;
  classic_amountoutgasadjusted: string;
  settledAmountIn: string;
  settledAmountOut: string;
  filler: string;
  filltimestamp: string;
};

const MINIMUM_ORDERS = 10;
const DISABLE_THRESHOLD = 0.2;

const handler: ScheduledHandler = async (_event: EventBridgeEvent<string, void>) => {
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
  // inputToken and outputToken MUST be sanitized and lowercased before being passed into the query
  const tokenInList = "('" + configs.map((config) => config.inputToken).join("', '") + "')";
  const tokenOutList = "('" + configs.map((config) => config.outputToken).join("', '") + "')";

  log.info(
    {
      tokenInList,
      tokenOutList,
      valueTokenInList: String(tokenInList),
      valueTokenOutList: String(tokenOutList),
    },
    'formatted tokenInList, tokenOutList'
  );

  function hasPositiveTradeOutcome(order: ResultRowType): {
    key: string;
    result: boolean;
  } {
    const tradeType =
      order.classic_amountin == order.classic_amountingasadjusted ? TradeType.EXACT_INPUT : TradeType.EXACT_OUTPUT;
    const trade: SynthSwitchQueryParams = {
      inputToken: order.tokenin,
      inputTokenChainId: parseInt(order.tokeninchainid),
      outputToken: order.tokenout,
      outputTokenChainId: parseInt(order.tokenoutchainid),
      type: String(tradeType),
      amount: tradeType == TradeType.EXACT_INPUT ? order.classic_amountin : order.classic_amountout,
    };
    const key = SwitchRepository.getKey(trade);
    let hasPriceImprovement: boolean;
    if (tradeType == TradeType.EXACT_INPUT) {
      hasPriceImprovement = BigNumber.from(order.settledAmountOut).gt(order.classic_amountoutgasadjusted);
    } else {
      hasPriceImprovement = BigNumber.from(order.classic_amountingasadjusted).gt(order.settledAmountIn);
    }
    // can add more conditionals here
    const result = hasPriceImprovement;
    return { key, result };
  }

  async function updateSynthSwitchRepository(configs: TokenConfig[], result: ResultRowType[]) {
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
      // totalTrades is both ExactIn and ExactOut
      const ordersForConfig =
        configMap[
          `${config.inputToken}#${config.inputTokenChainId}#${config.outputToken}#${config.outputTokenChainId}`
        ];
      // build trade objects differentiating between ExactIn and ExactOut
      let tradeOutcomesByKey: {
        [key: string]: {
          pos: number;
          neg: number;
        };
      } = {};
      for (const order of ordersForConfig) {
        const { key, result } = hasPositiveTradeOutcome(order);
        if (!(key in tradeOutcomesByKey)) {
          tradeOutcomesByKey[key] = {
            pos: 0,
            neg: 0,
          };
        }
        if (result) {
          tradeOutcomesByKey[key].pos++;
        } else {
          tradeOutcomesByKey[key].neg++;
        }
      }

      Object.keys(tradeOutcomesByKey).forEach(async (key) => {
        const { pos, neg } = tradeOutcomesByKey[key];
        const totalOrders = pos + neg;
        if (totalOrders >= MINIMUM_ORDERS) {
          if (neg / totalOrders >= DISABLE_THRESHOLD) {
            log.info(
              {
                key,
                ordersWithNegativeOutcome: neg,
                ordersWithPositiveOutcome: pos,
                totalOrders,
              },
              'Disabling synthethics for trade'
            );
            // TODO: update tradeSizes with new TokenConfig schema
            await synthSwitchEntity.putSynthSwitch(SwitchRepository.parseKey(key), config.tradeSizes[0], false);
            return;
          }
        }
        if (pos > 0) {
          log.info(
            {
              key,
              ordersWithNegativeOutcome: neg,
              ordersWithPositiveOutcome: pos,
              totalOrders,
            },
            'Enabling synthethics for trade'
          );
          // TODO: update tradeSizes with new TokenConfig schema
          await synthSwitchEntity.putSynthSwitch(SwitchRepository.parseKey(key), config.tradeSizes[0], true);
        }
      });
    }
  }

  // create view
  try {
    const createViewResponse = await client.send(
      new ExecuteStatementCommand({ ...sharedConfig, Sql: CREATE_COMBINED_URA_RESPONSES_VIEW_SQL })
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

  try {
    const executeResponse = await client.send(
      new ExecuteStatementCommand({
        ...sharedConfig,
        Sql: TEMPLATE_SYNTH_ORDERS_SQL,
        Parameters: [
          {
            name: 'token_in_list',
            value: String(tokenInList),
          },
          {
            name: 'token_out_list',
            value: String(tokenOutList),
          },
        ],
      })
    );
    stmtId = executeResponse.Id;
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

      const filteredResult = result.filter((row) => {
        // throw away rows where any field is null
        return Object.values(row).every((field) => field.stringValue);
      });

      const formattedResult = filteredResult.map((row) => {
        const formattedRow: ResultRowType = {
          tokenin: (row[0].stringValue as string).toLowerCase(),
          tokeninchainid: row[1].stringValue as string,
          dutch_amountin: row[2].stringValue as string,
          classic_amountin: row[3].stringValue as string,
          dutch_amountingasadjusted: row[4].stringValue as string,
          classic_amountingasadjusted: row[5].stringValue as string,
          tokenout: (row[6].stringValue as string).toLowerCase(),
          tokenoutchainid: row[7].stringValue as string,
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
      await updateSynthSwitchRepository(configs, formattedResult);
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

  // normalize token addresses
  configs = configs.map((config) => {
    return {
      ...config,
      inputToken: ethers.utils.getAddress(config.inputToken).toLowerCase(),
      outputToken: ethers.utils.getAddress(config.outputToken).toLowerCase(),
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
          AND filler = ''
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
          on ur.requestid = synth.requestid
          WHERE synth.createdat >= extract(epoch from (GETDATE() - INTERVAL '168 HOURS')) -- 7 days rolling window
  );
`;

// TODO: optionally we can add an additional time window here using filltimestamp
const TEMPLATE_SYNTH_ORDERS_SQL = `
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
  WHERE 
  LOWER(res.tokenin) in (:token_in_list)
  and 
  LOWER(res.tokenout) in (:token_out_list)
  ORDER by filltimestamp DESC
`;

module.exports = { handler };
