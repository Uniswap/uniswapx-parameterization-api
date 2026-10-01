import { rpcHeaders } from '../../lib/constants';

describe('rpcHeaders', () => {
  it('always sets the service id header', () => {
    expect(rpcHeaders()['x-uni-service-id']).toEqual('x_parameterization_api');
  });

  it('adds the x-internal-service-secret header when a secret is given', () => {
    expect(rpcHeaders('super-secret-value')['x-internal-service-secret']).toEqual('super-secret-value');
  });

  it('omits the x-internal-service-secret header without a secret', () => {
    expect(rpcHeaders()).not.toHaveProperty('x-internal-service-secret');
    expect(rpcHeaders('')).not.toHaveProperty('x-internal-service-secret');
  });
});
