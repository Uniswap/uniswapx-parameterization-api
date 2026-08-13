import { BillingMode } from 'aws-cdk-lib/aws-dynamodb';

import { TableCapacityConfig } from './stacks/cron-stack';

export const PROD_TABLE_CAPACITY: TableCapacityConfig = {
  fillerAddress: { billingMode: BillingMode.PROVISIONED, readCapacity: 70, writeCapacity: 250 },
  timestamps: { billingMode: BillingMode.PROVISIONED, readCapacity: 100, writeCapacity: 10 },
};
