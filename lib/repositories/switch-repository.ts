import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Logger from 'bunyan';
import { Entity, Table } from 'dynamodb-toolbox';

import { DYNAMO_TABLE_KEY, DYNAMO_TABLE_NAME } from '../constants';
import { SynthSwitchQueryParams, SynthSwitchTrade } from '../handlers/synth-switch';
import { BaseSwitchRepository } from './base';

export const PARTITION_KEY = `${DYNAMO_TABLE_KEY.TOKEN_IN}#${DYNAMO_TABLE_KEY.TOKEN_IN_CHAIN_ID}#${DYNAMO_TABLE_KEY.TOKEN_OUT}#${DYNAMO_TABLE_KEY.TOKEN_OUT_CHAIN_ID}#${DYNAMO_TABLE_KEY.TRADE_TYPE}`;

export class SwitchRepository implements BaseSwitchRepository {
  static log: Logger;

  static create(documentClient: DynamoDBDocumentClient): BaseSwitchRepository {
    this.log = Logger.createLogger({
      name: 'DynamoSwitchRepository',
      serializers: Logger.stdSerializers,
    });

    const switchTable = new Table({
      name: DYNAMO_TABLE_NAME.SYNTHETIC_SWITCH_TABLE,
      partitionKey: PARTITION_KEY,
      DocumentClient: documentClient,
    });

    const switchEntity = new Entity({
      name: 'SynthSwitchEntity',
      attributes: {
        [PARTITION_KEY]: { partitionKey: true },
        lower: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      table: switchTable,
      autoExecute: true,
    } as const);

    return new SwitchRepository(switchTable, switchEntity);
  }

  private constructor(
    // eslint-disable-next-line
    // @ts-expect-error
    private readonly _switchTable: Table<
      'SyntheticSwitchTable',
      'tokenIn#tokenInChainId#tokenOut#tokenOutChainId#type',
      'lower'
    >,
    private readonly switchEntity: Entity
  ) {}

  public async syntheticQuoteForTradeEnabled(trade: SynthSwitchQueryParams): Promise<boolean> {
    const { tokenIn, tokenInChainId, tokenOut, tokenOutChainId, type, amount } = trade;

    // get row for which lower bucket <= amount
    const pk = `${tokenIn}#${tokenInChainId}#${tokenOut}#${tokenOutChainId}#${type}`;
    const result = await this.switchEntity.get(
      {
        [PARTITION_KEY]: pk,
      },
      { execute: true, consistent: true }
    );

    SwitchRepository.log.info({ res: result.Item }, 'get result');
    if (result.Item && result.Item.lower <= amount) {
      return result.Item.enabled;
    } else {
      SwitchRepository.log.info({ pk }, 'No row found');
    }
    return false;
  }

  public async putSynthSwitch(trade: SynthSwitchTrade, lower: string, enabled: boolean): Promise<void> {
    const { tokenIn, tokenInChainId, tokenOut, tokenOutChainId, type } = trade;

    SwitchRepository.log.info(
      { pk: `${tokenIn}#${tokenInChainId}#${tokenOut}#${tokenOutChainId}#${type}` },
      'put pk'
    );
    await this.switchEntity.put(
      {
        [PARTITION_KEY]: `${tokenIn}#${tokenInChainId}#${tokenOut}#${tokenOutChainId}#${type}`,
        [`${DYNAMO_TABLE_KEY.LOWER}`]: lower,
        enabled: enabled,
      },
      { execute: true }
    );
  }

  static getKey(trade: SynthSwitchTrade): string {
    console.log('in getKey')
    const { tokenIn, tokenInChainId, tokenOut, tokenOutChainId, type } = trade;
    console.log(tokenIn, tokenInChainId, tokenOut, tokenOutChainId, type)
    return `${tokenIn}#${tokenInChainId}#${tokenOut}#${tokenOutChainId}#${type}`;
  }

  static parseKey(key: string): SynthSwitchTrade {
    const [tokenIn, tokenInChainId, tokenOut, tokenOutChainId, type] = key.split('#');
    if (!tokenIn || !tokenInChainId || !tokenOut || !tokenOutChainId || !type)
      throw new Error(`Invalid key: ${key}`);
    return {
      tokenIn,
      tokenInChainId: parseInt(tokenInChainId),
      tokenOut: tokenOut,
      tokenOutChainId: parseInt(tokenOutChainId),
      type,
    };
  }
}
