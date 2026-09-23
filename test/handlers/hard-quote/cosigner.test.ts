import { KmsSigner } from '@uniswap/signer';

import { kmsCosignerFactory } from '../../../lib/handlers/hard-quote/cosigner';

// These pin the behavior the handler had when it built the signer inline: config is read on
// each call (so missing config fails the request, not the container build), and every call
// gets a fresh KMS client (the SDK clock-skew workaround). Constructing KmsSigner/KMSClient
// does no I/O, so no credentials are needed.
describe('kmsCosignerFactory', () => {
  const saved = { KMS_KEY_ID: process.env.KMS_KEY_ID, REGION: process.env.REGION };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('builds without reading KMS config', () => {
    delete process.env.KMS_KEY_ID;
    delete process.env.REGION;
    expect(() => kmsCosignerFactory()).not.toThrow();
  });

  it('fails the call, not the build, when KMS config is missing', () => {
    delete process.env.KMS_KEY_ID;
    process.env.REGION = 'us-east-2';
    const factory = kmsCosignerFactory();
    expect(() => factory()).toThrow('KMS_KEY_ID is not defined');

    process.env.KMS_KEY_ID = 'test-key-id';
    delete process.env.REGION;
    expect(() => factory()).toThrow('REGION is not defined');
  });

  it('returns a new KMS-backed signer on every call', () => {
    process.env.KMS_KEY_ID = 'test-key-id';
    process.env.REGION = 'us-east-2';
    const factory = kmsCosignerFactory();
    const first = factory();
    expect(first).toBeInstanceOf(KmsSigner);
    expect(factory()).not.toBe(first);
  });
});
