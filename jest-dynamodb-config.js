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
    }
  ],
  port: 8000,
};
