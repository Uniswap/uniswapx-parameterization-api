import { DocumentClient } from 'aws-sdk/clients/dynamodb';
import { Entity, Table } from 'dynamodb-toolbox';

import { DYNAMODB_TYPE, QUOTES_TABLE_INDEX, QUOTES_TABLE_KEY } from '../config/dynamodb';
import { QuoteRequest, QuoteResponse } from '../entities';
import { BaseQuotesRepository } from './base-quotes-repository';

export class DynamoQuotesRepository implements BaseQuotesRepository {
  static create(documentClient: DocumentClient): BaseQuotesRepository {
    const quotesTable = new Table({
      name: 'Quotes',
      partitionKey: QUOTES_TABLE_KEY.REQUEST_ID,
      sortKey: QUOTES_TABLE_KEY.TYPE,
      DocumentClient: documentClient,
      indexes: {
        [QUOTES_TABLE_INDEX.OFFERER_TYPE]: {
          partitionKey: QUOTES_TABLE_INDEX.OFFERER_TYPE,
          sortKey: QUOTES_TABLE_KEY.CREATED_AT,
        },
        [QUOTES_TABLE_INDEX.FILLER]: {
          partitionKey: QUOTES_TABLE_INDEX.FILLER,
          sortKey: QUOTES_TABLE_KEY.CREATED_AT,
        },
      },
    });

    const quoteRequestEntity = new Entity({
      name: 'QuoteRequest',
      attributes: {
        requestId: { partitionKey: true, type: DYNAMODB_TYPE.STRING },
        type: { sortKey: true, type: DYNAMODB_TYPE.STRING },
        tokenIn: { type: DYNAMODB_TYPE.STRING, required: true },
        amountIn: { type: DYNAMODB_TYPE.STRING, required: true },
        tokenOut: { type: DYNAMODB_TYPE.STRING, required: true },
        offerer: { type: DYNAMODB_TYPE.STRING, required: true },
        createdAt: { type: DYNAMODB_TYPE.NUMBER, required: true },
        deadline: { type: DYNAMODB_TYPE.NUMBER, required: true },
      },
      table: quotesTable,
    } as const);

    const quoteResponseEntity = new Entity({
      name: 'QuoteResponse',
      attributes: {
        requestId: { partitionKey: true, type: DYNAMODB_TYPE.STRING },
        type: { sortKey: true, type: DYNAMODB_TYPE.STRING },
        id: { type: DYNAMODB_TYPE.STRING, required: true },
        tokenIn: { type: DYNAMODB_TYPE.STRING, required: true },
        amountIn: { type: DYNAMODB_TYPE.STRING, required: true },
        tokenOut: { type: DYNAMODB_TYPE.STRING, required: true },
        offerer: { type: DYNAMODB_TYPE.STRING, required: true },
        createdAt: { type: DYNAMODB_TYPE.NUMBER, required: true },
        filler: { type: DYNAMODB_TYPE.STRING, required: true },
        amountOut: { type: DYNAMODB_TYPE.STRING, required: true },
        deadline: { type: DYNAMODB_TYPE.NUMBER, required: true },
      },
      table: quotesTable,
    } as const);

    return new DynamoQuotesRepository(quotesTable, quoteRequestEntity, quoteResponseEntity);
  }

  private constructor(
    private readonly quotesTable: Table<'Quotes', QUOTES_TABLE_KEY.REQUEST_ID, QUOTES_TABLE_KEY.TYPE>,
    private readonly quoteRequestEntity: Entity,
    private readonly quoteResponseEntity: Entity
  ) {}

  public async putRequest(request: QuoteRequest): Promise<void> {
    await this.quoteRequestEntity.put(request, {
      execute: true,
    });
  }

  public async putResponses(responses: QuoteResponse[]): Promise<void> {
    await this.quotesTable.batchWrite(
      responses.map((response) => this.quoteResponseEntity.putBatch(response)),
      {
        execute: true,
      }
    );
  }

  public async getRequestById(requestId: string): Promise<QuoteRequest | null> {
    const response = await this.quoteRequestEntity.query(requestId, {
      beginsWith: 'request',
      execute: true,
    });
    return (response.Items?.[0] as QuoteRequest) ?? null;
  }

  public async getAllResponsesByRequestId(requestId: string): Promise<QuoteResponse[]> {
    const responses = await this.quotesTable.query(requestId, {
      beginsWith: 'response',
      reverse: true, // newest first
      execute: true,
    });

    return responses.Items as QuoteResponse[];
  }
}
