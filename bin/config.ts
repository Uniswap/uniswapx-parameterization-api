import { BillingMode } from 'aws-cdk-lib/aws-dynamodb';

import { TableCapacityConfig } from './stacks/cron-stack';

export const PROD_TABLE_CAPACITY: TableCapacityConfig = {
  fillerAddress: { billingMode: BillingMode.PROVISIONED, readCapacity: 20, writeCapacity: 100 },
  fadeRate: { billingMode: BillingMode.PROVISIONED, readCapacity: 50, writeCapacity: 5 },
  synthSwitch: { billingMode: BillingMode.PROVISIONED, readCapacity: 2000, writeCapacity: 5 },
  timestamps: { billingMode: BillingMode.PROVISIONED, readCapacity: 50, writeCapacity: 50 },
};
