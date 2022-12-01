import * as cdk from 'aws-cdk-lib';
import * as aws_dynamo from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

import { QUOTES_TABLE_INDEX, QUOTES_TABLE_KEY } from '../../lib/config/dynamodb';
import { SERVICE_NAME } from '../constants';

type DynamoStackProps = cdk.NestedStackProps;

export class DynamoStack extends cdk.NestedStack {
  public readonly quotesTable: aws_dynamo.Table;

  constructor(scope: Construct, id: string, props: DynamoStackProps) {
    super(scope, id, props);

    /* orders table */
    this.quotesTable = new aws_dynamo.Table(this, `${SERVICE_NAME}OrdersTable`, {
      tableName: 'Quotes',
      partitionKey: {
        name: QUOTES_TABLE_KEY.REQUEST_ID,
        type: aws_dynamo.AttributeType.STRING,
      },
      sortKey: {
        name: QUOTES_TABLE_KEY.TYPE,
        type: aws_dynamo.AttributeType.STRING,
      },
      billingMode: aws_dynamo.BillingMode.PAY_PER_REQUEST,
    });

    this.quotesTable.addGlobalSecondaryIndex({
      indexName: QUOTES_TABLE_INDEX.OFFERER_TYPE,
      partitionKey: {
        name: `${QUOTES_TABLE_KEY.OFFERER}_${QUOTES_TABLE_KEY.TYPE}`,
        type: aws_dynamo.AttributeType.STRING,
      },
      sortKey: {
        name: QUOTES_TABLE_KEY.CREATED_AT,
        type: aws_dynamo.AttributeType.STRING,
      },
      projectionType: aws_dynamo.ProjectionType.ALL,
    });

    this.quotesTable.addGlobalSecondaryIndex({
      indexName: QUOTES_TABLE_KEY.FILLER,
      partitionKey: {
        name: QUOTES_TABLE_KEY.FILLER,
        type: aws_dynamo.AttributeType.STRING,
      },
      sortKey: {
        name: QUOTES_TABLE_KEY.CREATED_AT,
        type: aws_dynamo.AttributeType.STRING,
      },
      projectionType: aws_dynamo.ProjectionType.ALL,
    });
  }
}
