import { BillingMode } from 'aws-cdk-lib/aws-dynamodb';

import { STAGE } from '../lib/util/stage';
import { BACKEND_DEV_ACCOUNT, BACKEND_PROD_ACCOUNT, BACKEND_STAGING_ACCOUNT } from './constants';
import { TableCapacityConfig } from './stacks/cron-stack';

export const PROD_TABLE_CAPACITY: TableCapacityConfig = {
  fillerAddress: { billingMode: BillingMode.PROVISIONED, readCapacity: 250, writeCapacity: 250 },
  timestamps: { billingMode: BillingMode.PROVISIONED, readCapacity: 100, writeCapacity: 10 },
};

// Backend accounts allowed to sign with each stage's hard-quote cosigner key. Never cross this
// mapping: staging must not be able to sign with the prod key.
export const HARD_QUOTE_COSIGNER_BACKEND_ACCOUNTS: Record<STAGE.BETA | STAGE.PROD, readonly string[]> = {
  [STAGE.BETA]: [BACKEND_DEV_ACCOUNT, BACKEND_STAGING_ACCOUNT],
  [STAGE.PROD]: [BACKEND_PROD_ACCOUNT],
};

// Backend accounts allowed to reach each stage's market-maker egress proxy over PrivateLink
// (bin/stacks/egress-proxy.ts). Same mapping as the cosigner key: beta traffic stays with
// backend dev and staging, prod with backend prod.
export const EGRESS_PROXY_BACKEND_ACCOUNTS: Record<STAGE.BETA | STAGE.PROD, readonly string[]> = {
  [STAGE.BETA]: [BACKEND_DEV_ACCOUNT, BACKEND_STAGING_ACCOUNT],
  [STAGE.PROD]: [BACKEND_PROD_ACCOUNT],
};

// Backend accounts allowed to write GPA analytics records into each stage's S3 -> BigQuery path
// (bin/stacks/backend-analytics-writer.ts). Same mapping again: beta analytics come only from
// backend dev and staging, prod analytics only from backend prod.
export const ANALYTICS_WRITER_BACKEND_ACCOUNTS: Record<STAGE.BETA | STAGE.PROD, readonly string[]> = {
  [STAGE.BETA]: [BACKEND_DEV_ACCOUNT, BACKEND_STAGING_ACCOUNT],
  [STAGE.PROD]: [BACKEND_PROD_ACCOUNT],
};
