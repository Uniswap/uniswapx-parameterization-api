module.exports = {
  tables: [
    {
      TableName: `FillerAddress`,
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 },
    },
    {
      TableName: 'FillerCBTimestampsV2',
      KeySchema: [
        { AttributeName: 'hash', KeyType: 'HASH' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'hash', AttributeType: 'S' },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 },
    },
    // Mirrors PostedOrdersTable in bin/stacks/api-stack.ts (keys + both GSIs; TTL is not
    // modelled by DynamoDB Local).
    {
      TableName: 'PostedOrders',
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'orderHash', KeyType: 'HASH' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'orderHash', AttributeType: 'S' },
        { AttributeName: 'pending', AttributeType: 'S' },
        { AttributeName: 'filler', AttributeType: 'S' },
        { AttributeName: 'deadline', AttributeType: 'N' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'pending-deadline-index',
          KeySchema: [
            { AttributeName: 'pending', KeyType: 'HASH' },
            { AttributeName: 'deadline', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'filler-deadline-index',
          KeySchema: [
            { AttributeName: 'filler', KeyType: 'HASH' },
            { AttributeName: 'deadline', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    },
  ],
  port: 8000,
};
