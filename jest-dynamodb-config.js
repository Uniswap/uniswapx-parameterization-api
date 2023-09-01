module.exports = {
  tables: [
    {
      TableName: `SyntheticSwitch`,
      KeySchema: [
        { AttributeName: 'tokenIn#tokenInChainId#tokenOut#tokenOutChainId#type', KeyType: 'HASH' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'tokenIn#tokenInChainId#tokenOut#tokenOutChainId#type', AttributeType: 'S' },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 },
    },
  ],
  port: 8000,
};
