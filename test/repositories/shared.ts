import { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';

export const DYNAMO_CONFIG: DynamoDBClientConfig = {
  endpoint: 'http://localhost:8000',
  region: 'local',
  credentials: {
    accessKeyId: 'fakeMyKeyId',
    secretAccessKey: 'fakeSecretAccessKey',
  },
};
