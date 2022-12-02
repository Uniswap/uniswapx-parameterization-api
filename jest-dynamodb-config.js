module.exports = {
  tables: [
    {
      TableName: 'Quotes',
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      KeySchema: [
        { AttributeName: 'requestId', KeyType: 'HASH' },
        { AttributeName: 'type', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'requestId', AttributeType: 'S' },
        { AttributeName: 'type', AttributeType: 'S' },
        { AttributeName: 'offerer-type', AttributeType: 'S' },
        { AttributeName: 'filler', AttributeType: 'S' },
        { AttributeName: 'createdAt', AttributeType: 'N' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'offerer-type',
          KeySchema: [
            { AttributeName: 'offerer-type', KeyType: 'HASH' },
            { AttributeName: 'createdAt', KeyType: 'RANGE' },
          ],
          Projection: {
            ProjectionType: 'ALL',
          },
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        },
        {
          IndexName: 'filler',
          KeySchema: [
            { AttributeName: 'filler', KeyType: 'HASH' },
            { AttributeName: 'createdAt', KeyType: 'RANGE' },
          ],
          Projection: {
            ProjectionType: 'ALL',
          },
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        },
      ],
    }
  ],
}
