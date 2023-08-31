module.exports = {
  tables: [
    {
      TableName: `SyntheticSwitch`,
      KeySchema: [
        { AttributeName: 'inputToken#inputTokenChainId#outputToken#outputTokenChainId#type', KeyType: 'HASH' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'inputToken#inputTokenChainId#outputToken#outputTokenChainId#type', AttributeType: 'S' },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 },
    },
  ],
  port: 8000,
};
