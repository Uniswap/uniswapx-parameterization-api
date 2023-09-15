import { EventBridgeEvent, ScheduledHandler } from 'aws-lambda';

import { checkDefined } from '../preconditions/preconditions';
import { AnalyticsRepository, SharedConfigs, TimestampThreshold } from '../repositories/analytics-repository';

const CREATEDAT = 'createdat';
const TABLES_TO_CLEAN = [
  'unifiedroutingrequests',
  'unifiedroutingresponses',
  'rfqrequests',
  'rfqresponses',
  'archivedorders',
  'postedorders',
];

export const handler: ScheduledHandler = async (_event: EventBridgeEvent<string, void>) => {
  const sharedConfig: SharedConfigs = {
    Database: checkDefined(process.env.REDSHIFT_DATABASE),
    ClusterIdentifier: checkDefined(process.env.REDSHIFT_CLUSTER_IDENTIFIER),
    SecretArn: checkDefined(process.env.REDSHIFT_SECRET_ARN),
  };
  const analyticsRepository = AnalyticsRepository.create(sharedConfig);

  // needs to be sequential be cause of the vacuum command
  for (const table of TABLES_TO_CLEAN) {
    await analyticsRepository.cleanUpTable(table, CREATEDAT, TimestampThreshold.TWO_MONTHS);
  }
};
