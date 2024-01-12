module.exports = {
  tables: [
    {
      TableName: `SyntheticSwitchTable`,
      KeySchema: [
        { AttributeName: 'tokenIn#tokenInChainId#tokenOut#tokenOutChainId#type', KeyType: 'HASH' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'tokenIn#tokenInChainId#tokenOut#tokenOutChainId#type', AttributeType: 'S' },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 },
    },
    {
      TableName: 'FillerCBTimestamps',
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
