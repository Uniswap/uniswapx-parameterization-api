import { RedshiftDataClient } from '@aws-sdk/client-redshift-data';
import { V2FadesRepository } from '../../lib/repositories';

describe('FadesRepository Integration Tests', () => {
  let v2FadesRepository: V2FadesRepository;

  beforeAll(() => {
    // Create repositories with real Redshift client
    const client = new RedshiftDataClient({});
    const configs = {
      Database: process.env.REDSHIFT_DATABASE!,
      ClusterIdentifier: process.env.REDSHIFT_CLUSTER_IDENTIFIER!,
      SecretArn: process.env.REDSHIFT_SECRET_ARN!,
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
