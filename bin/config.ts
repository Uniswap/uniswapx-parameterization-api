import { BillingMode } from 'aws-cdk-lib/aws-dynamodb';

import { TableCapacityConfig } from './stacks/cron-stack';

export const PROD_TABLE_CAPACITY: TableCapacityConfig = {
  fadeRate: { billingMode: BillingMode.PROVISIONED, readCapacity: 50, writeCapacity: 5 },
};
