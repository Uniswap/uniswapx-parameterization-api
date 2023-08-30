import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Logger from 'bunyan';
import { Entity, Table } from 'dynamodb-toolbox';

import { DYNAMO_TABLE_KEY, DYNAMO_TABLE_NAME } from '../constants';
import { SynthSwitchQueryParams } from '../handlers/synth-switch';
import { BaseSwitchRepository } from './base';

export const PARTITION_KEY = `${DYNAMO_TABLE_KEY.INPUT_TOKEN}#${DYNAMO_TABLE_KEY.INPUT_TOKEN_CHAIN_ID}#${DYNAMO_TABLE_KEY.OUTPUT_TOKEN}#${DYNAMO_TABLE_KEY.OUTPUT_TOKEN_CHAIN_ID}#${DYNAMO_TABLE_KEY.TRADE_TYPE}`;

export class SwitchRepository implements BaseSwitchRepository {
  static log: Logger;

  static create(documentClient: DynamoDBDocumentClient): BaseSwitchRepository {
    this.log = Logger.createLogger({
      name: 'DynamoSwitchRepository',
      serializers: Logger.stdSerializers,
    });

    const switchTable = new Table({
      name: DYNAMO_TABLE_NAME.SYNTH_SWITCH,
      partitionKey: PARTITION_KEY,
      sortKey: `${DYNAMO_TABLE_KEY.LOWER}`,
      DocumentClient: documentClient,
    });

    const switchEntity = new Entity({
      name: 'SynthSwitchEntity',
      attributes: {
        [PARTITION_KEY]: { partitionKey: true },
        lower: { sortKey: true },
        enabled: { type: 'boolean' },
      },
      table: switchTable,
      autoExecute: true,
    } as const);

    return new SwitchRepository(switchTable, switchEntity);
  }

  private constructor(
    // eslint-disable-next-line
    private readonly _switchTable: Table<
      'SynthSwitch',
      'inputToken#inputTokenChainId#outputToken#outputTokenChainId#type',
      'lower'
    >,
    private readonly switchEntity: Entity
  ) {}

  public async syntheticQuoteForTradeEnabled(trade: SynthSwitchQueryParams): Promise<boolean> {
    const { inputToken, inputTokenChainId, outputToken, outputTokenChainId, type, amount } = trade;

    SwitchRepository.log.info({ trade: trade });
    // get row for which lower bucket <= amount
    const result = await this.switchEntity.query(
      `${inputToken}#${inputTokenChainId}#${outputToken}#${outputTokenChainId}#${type}`,
      {
        limit: 1,
        lte: `${amount}`,
        reverse: true,
      }
    );
    if (result.Items && result.Items.length) {
      SwitchRepository.log.info({ res: result.Items });
      // our design assumes that at most one row (thus one lower) will be present
      // for the input/output/chains/type combo
      // if somehow more than one row exists, return the one with highest 'upper'
      if (result.Items.length > 1) {
        SwitchRepository.log.error({ res: result.Items }, 'More than one row returned for switch query');
      }
      return result.Items[0].enabled;
    }
    return false;
  }

  public async putSynthSwitch(trade: SynthSwitchQueryParams, lower: string, enabled: boolean): Promise<void> {
    SwitchRepository.log.info({ tableName: this._switchTable.name, pk: PARTITION_KEY });
    const { inputToken, inputTokenChainId, outputToken, outputTokenChainId, type } = trade;

    await this.switchEntity.put({
      [PARTITION_KEY]: `${inputToken}#${inputTokenChainId}#${outputToken}#${outputTokenChainId}#${type}`,
      [`${DYNAMO_TABLE_KEY.LOWER}`]: lower,
      enabled: enabled,
    });
  }
}
