import { KmsSigner } from '@uniswap/signer';

import { kmsCosignerFactory } from '../../lib/core/cosigner';

// Every call gets a fresh KMS client (the SDK clock-skew workaround). Constructing
// KmsSigner/KMSClient does no I/O, so no credentials are needed.
describe('kmsCosignerFactory', () => {
  it('returns a new KMS-backed signer on every call', () => {
    const factory = kmsCosignerFactory({ kmsKeyId: 'test-key-id', region: 'us-east-2' });
    const first = factory();
    expect(first).toBeInstanceOf(KmsSigner);
    expect(factory()).not.toBe(first);
  });
});
