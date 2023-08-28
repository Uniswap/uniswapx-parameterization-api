import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Logger from 'bunyan';
import { Entity, Table } from 'dynamodb-toolbox';

import { DYNAMO_TABLE_KEY, DYNAMO_TABLE_NAME } from '../constants';
import { SynthSwitchRequestBody } from '../handlers/synth-switch';
import { BaseSwitchRepository } from './base';

const PARTITION_KEY = `${DYNAMO_TABLE_KEY.INPUT_TOKEN}#${DYNAMO_TABLE_KEY.INPUT_TOKEN_CHAIN_ID}${DYNAMO_TABLE_KEY.OUTPUT_TOKEN}#${DYNAMO_TABLE_KEY.OUTPUT_TOKEN_CHAIN_ID}#${DYNAMO_TABLE_KEY.TRADE_TYPE}`;

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
      name: 'SynthSwitch',
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
    private readonly: Table<'SynthSwitch', 'inputToken', 'outputToken'>,
    private readonly switchEntity: Entity
  ) {}

  public async syntheticQuoteForTradeEnabled(trade: SynthSwitchRequestBody): Promise<boolean> {
    const { inputToken, inputTokenChainId, outputToken, outputTokenChainId, type, amount } = trade;

    // get row for which lower bucket <= amount < upper bucket
    const result = await this.switchEntity.query(
      `${inputToken}#${inputTokenChainId}#${outputToken}#${outputTokenChainId}#${type}`,
      {
        limit: 1,
        filters: [
          { attr: 'lower', lte: amount },
          { attr: 'upper', gt: amount },
        ],
      }
    );
    if (result.Items && result.Items.length) {
      return result.Items[0].enabled;
    }
    return false;
  }

  public async putSynthSwitch(
    trade: SynthSwitchRequestBody,
    lower: string,
    upper: string,
    enabled: boolean
  ): Promise<void> {
    const { inputToken, inputTokenChainId, outputToken, outputTokenChainId, type } = trade;

    await this.switchEntity.put({
      [PARTITION_KEY]: `${inputToken}#${inputTokenChainId}#${outputToken}#${outputTokenChainId}#${type}`,
      [`${DYNAMO_TABLE_KEY.LOWER}`]: lower,
      [`${DYNAMO_TABLE_KEY.UPPER}`]: upper,
      enabled: enabled,
    });
  }
}
