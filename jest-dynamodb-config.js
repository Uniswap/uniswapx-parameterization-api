module.exports = {
  tables: [
    {
      TableName: `SynthSwitch`,
      KeySchema: [
        { AttributeName: 'inputToken#inputTokenChainId#outputToken#outputTokenChainId#type', KeyType: 'HASH' },
        {
          AttributeName: 'lower',
          KeyType: 'RANGE',
        },
      ],
      AttributeDefinitions: [
        { AttributeName: 'inputToken#inputTokenChainId#outputToken#outputTokenChainId#type', AttributeType: 'S' },
        { AttributeName: 'lower', AttributeType: 'S' },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 },
    },
  ],
  port: 8000,
};
