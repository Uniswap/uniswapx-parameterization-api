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
import { BigNumber, ethers } from 'ethers';
import { TradeType } from '@uniswap/sdk-core';
import { SwitchRepository } from '../repositories/switch-repository';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

type TokenConfig = {
  inputToken: string;
  inputTokenChainId: number;
  outputToken: string;
  outputTokenChainId: number;
  tradeTypes: string[];
  tradeSizes: string[]; // inclusive range [lower, upper]
};

export type SynthSwitchRequestBody = {
  inputToken: string, 
  inputTokenChainId: string, 
  outputToken: string, 
  outputTokenChainId: string, 
  type: string, // tradeType
  amount: string
}

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
}

const handler: ScheduledHandler = async (_event: EventBridgeEvent<string, void>) => {
  const log: Logger = bunyan.createLogger({
    name: 'SynthPairsCron',
    serializers: bunyan.stdSerializers,
    level: 'info',
  });

  const client = new RedshiftDataClient({});
  const synthSwitchEntity = SwitchRepository.create(DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: {
      convertEmptyValues: true,
    },
    unmarshallOptions: {
      wrapNumbers: true,
    },
  }));

  const sharedConfig = {
    Database: process.env.REDSHIFT_DATABASE,
    ClusterIdentifier: process.env.REDSHIFT_CLUSTER_IDENTIFIER,
    SecretArn: process.env.REDSHIFT_SECRET_ARN,
  };

  log.info({ config: sharedConfig }, 'sharedConfig');

  let stmtId: string | undefined;

  const configs = validateConfigs(await readTokenConfig(log));
  // tokens are all validated to be addresses + lowercased
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
  )

  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - 60 * 60 * 24 * 7; // 7 days ago

  async function updateSynthSwitchRepository(result: ResultRowType[]) {
    let numNegativePISwaps: {
      [key: string]: number
    } = {}
    // turn on criteria: one profitable trade
    for(const row of result) {
      // determine tradeType
      const tradeType = row.classic_amountin == row.classic_amountingasadjusted ? TradeType.EXACT_INPUT : TradeType.EXACT_OUTPUT;
      const trade: SynthSwitchRequestBody = {
        inputToken: row.tokenin,
        inputTokenChainId: row.tokeninchainid,
        outputToken: row.tokenout,
        outputTokenChainId: row.tokenoutchainid,
        type: String(tradeType),
        // classic amount in here or synthetic amount in?
        amount: tradeType == TradeType.EXACT_INPUT ? row.classic_amountin : row.classic_amountout,
      }

      let priceImprovement: boolean;
      if(tradeType == TradeType.EXACT_INPUT) {
        priceImprovement = BigNumber.from(row.settledAmountOut).gt(row.classic_amountoutgasadjusted);
      }
      else {
        priceImprovement = BigNumber.from(row.classic_amountingasadjusted).gt(row.settledAmountIn);
      }
      
      const key = SwitchRepository.getKey(trade);
      if(priceImprovement) {
        await synthSwitchEntity.putSynthSwitch(
          trade, 
          // TODO: change lower to support minimum trade size. 0 enables all trade sizes
          '0', 
          true
        )
      }
      else {
        (key in numNegativePISwaps) ? numNegativePISwaps[key] += 1 : numNegativePISwaps[key] = 1;
      }
    }

    // turn off criteria: 2 consecutive unprofitable trades over this window
    Object.keys(numNegativePISwaps).forEach(async (key) => {
      if(numNegativePISwaps[key] >= 2) {
        const trade = SwitchRepository.parseKey(key);
        if(await synthSwitchEntity.syntheticQuoteForTradeEnabled(trade)) {
          await synthSwitchEntity.putSynthSwitch(
            trade,
            '0',
            false)
          }
        }
      });
  }

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
      const filteredResult = result.filter((row) => {
        // throw away rows where any field is null
        return Object.values(row).every((field) => field.stringValue);
      });

      const formattedResult = filteredResult.map((row) => {
        const formattedRow: ResultRowType = {
          tokenin: row[0].stringValue as string,
          tokeninchainid: row[1].stringValue as string,
          dutch_amountin: row[2].stringValue as string,
          classic_amountin: row[3].stringValue as string,
          dutch_amountingasadjusted: row[4].stringValue as string,
          classic_amountingasadjusted: row[5].stringValue as string,
          tokenout: row[6].stringValue as string,
          tokenoutchainid: row[7].stringValue as string,
          dutch_amountout: row[8].stringValue as string,
          classic_amountout: row[9].stringValue as string,
          dutch_amountoutgasadjusted: row[10].stringValue as string,
          classic_amountoutgasadjusted: row[11].stringValue as string,
          settledAmountIn: row[12].stringValue as string,
          settledAmountOut: row[13].stringValue as string,
          filler: row[14].stringValue as string,
          filltimestamp: row[15].stringValue as string,
        };
        return formattedRow;
      });
      await updateSynthSwitchRepository(formattedResult);
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

  return configs
}

const TEMPLATE_SYNTH_ORDERS_SQL = `
WITH sr AS (
    SELECT
        *
    FROM
        "uniswap_x"."public"."unifiedroutingresponses"
    WHERE routing = 'DUTCH_LIMIT'
    AND filler = ''
    AND LOWER(tokenIn) IN (:token_in_list)
    AND LOWER(tokenOut) IN (:token_out_list)
), 
r AS (
    select
        sr.quoteid,
        sr.tokenin,
        sr.tokeninchainid,
        sr.amountin AS dutch_amountin,
        ur.amountin as classic_amountin,
        sr.amountingasadjusted as dutch_amountingasadjusted,
        ur.amountingasadjusted as classic_amountingasadjusted,
        sr.tokenout,
        sr.tokenoutchainid,
        sr.amountout as dutch_amountout,
        ur.amountout as classic_amountout,
        sr.amountoutgasadjusted as dutch_amountoutgasadjusted,
        ur.amountoutgasadjusted as classic_amountoutgasadjusted
    from sr 
    join "uniswap_x"."public"."unifiedroutingresponses" ur
    on ur.requestid = sr.requestid
)

SELECT * FROM (
    SELECT
        r.tokenin,
        r.tokeninchainid,
        dutch_amountin,
        classic_amountin,
        dutch_amountingasadjusted,
        classic_amountingasadjusted,
        r.tokenout,
        r.tokenoutchainid,
        dutch_amountout,
        classic_amountout,
        dutch_amountoutgasadjusted,
        classic_amountoutgasadjusted,
        ao.amountin as settledAmountIn,
        ao.amountout as settledAmountOut,
        ao.filler,
        ao.filltimestamp
    FROM
        "uniswap_x"."public"."archivedorders" ao
    JOIN r ON ao.quoteid = r.quoteid
    WHERE ao.orderstatus = 'filled'
    AND ao.filltimestamp BETWEEN :start_time AND :end_time
) as filled_synthetic_orders_and_responses
ORDER BY filled_synthetic_orders_and_responses.filltimestamp DESC;
`;

module.exports = { handler };
