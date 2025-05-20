import { RedshiftDataClient } from '@aws-sdk/client-redshift-data';
import { V2FadesRepository } from '../../lib/repositories';
import { checkDefined } from '../../lib/preconditions/preconditions';

describe('FadesRepository Integration Tests', () => {
  let v2FadesRepository: V2FadesRepository;

  beforeAll(() => {

    const REDSHIFT_DATABASE = checkDefined(
        process.env.REDSHIFT_DATABASE,
        'Must set REDSHIFT_DATABASE env variable for integ tests. See README'
    );
    const REDSHIFT_CLUSTER_IDENTIFIER = checkDefined(
        process.env.REDSHIFT_CLUSTER_IDENTIFIER,
        'Must set REDSHIFT_CLUSTER_IDENTIFIER env variable for integ tests. See README'
    );
    const REDSHIFT_SECRET_ARN = checkDefined(
        process.env.REDSHIFT_SECRET_ARN,
        'Must set REDSHIFT_SECRET_ARN env variable for integ tests. See README'
    );
    const client = new RedshiftDataClient({});
    const configs = {
      Database: REDSHIFT_DATABASE,
      ClusterIdentifier: REDSHIFT_CLUSTER_IDENTIFIER,
      SecretArn: REDSHIFT_SECRET_ARN,
    };

    v2FadesRepository = new V2FadesRepository(client, configs);
  });

  describe('createFadesView', () => {
    it('should successfully create V2 fades view', async () => {
      await expect(v2FadesRepository.createFadesView()).resolves.not.toThrow();
      const result = await v2FadesRepository.getFades();
      expect(result).toBeDefined();
    });
  });
});
