import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Logger from 'bunyan';
import { Entity, Table } from 'dynamodb-toolbox';

import { DYNAMO_TABLE_KEY, DYNAMO_TABLE_NAME } from '../constants';
import { BaseSwitchRepository } from './base';
import { SynthSwitchRequestBody, SynthSwitchTrade } from '../handlers/synth-switch';

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

  public async syntheticQuoteForTradeEnabled(trade: SynthSwitchRequestBody): Promise<boolean> {
    const { inputToken, inputTokenChainId, outputToken, outputTokenChainId, type, amount } = trade;

    // get row for which lower bucket <= amount
    const result = await this.switchEntity.query(
      `${inputToken}#${inputTokenChainId}#${outputToken}#${outputTokenChainId}#${type}`,
      {
        limit: 1,
        lte: `${amount}`,
      }
    );
    if (result.Items && result.Items.length) {
      return result.Items[0].enabled;
    }
    return false;
  }

  public async putSynthSwitch(trade: SynthSwitchTrade, lower: string, enabled: boolean): Promise<void> {
    SwitchRepository.log.info({ tableName: this._switchTable.name, pk: PARTITION_KEY });
    const { inputToken, inputTokenChainId, outputToken, outputTokenChainId, type } = trade;

    await this.switchEntity.put({
      [PARTITION_KEY]: `${inputToken}#${inputTokenChainId}#${outputToken}#${outputTokenChainId}#${type}`,
      [`${DYNAMO_TABLE_KEY.LOWER}`]: lower,
      enabled: enabled,
    });
  }
  
  static getKey(trade: SynthSwitchTrade): string {
    const { inputToken, inputTokenChainId, outputToken, outputTokenChainId, type } = trade;
    return `${inputToken}#${inputTokenChainId}#${outputToken}#${outputTokenChainId}#${type}`;
  }

  static parseKey(key: string): SynthSwitchTrade {
    const [inputToken, inputTokenChainId, outputToken, outputTokenChainId, type] = key.split('#');
    return {
      inputToken,
      inputTokenChainId: parseInt(inputTokenChainId),
      outputToken,
      outputTokenChainId: parseInt(outputTokenChainId),
      type,
    };
  }
}
