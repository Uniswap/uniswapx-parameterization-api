import { KMSClient } from '@aws-sdk/client-kms';
import { KmsSigner } from '@uniswap/signer';

/**
 * The two operations the hard-quote path needs from its cosigning key. The key's address is
 * the cosigner that the order service and the reactors verify, so the key itself can never be
 * recreated; only the client that reaches it is swappable.
 */
export interface Cosigner {
  getAddress(): Promise<string>;
  signDigest(digest: Buffer | string): Promise<string>;
}

/** Builds the cosigner for one request. */
export type CosignerFactory = () => Cosigner;

/**
 * Production factory: the KMS-backed signer, rebuilt on every call.
 *
 * A fresh KMSClient per request works around the SDK clock-skew bug
 * (https://github.com/aws/aws-sdk-js-v3/issues/6400). The key id and region are read once, with
 * the rest of the container's config. A long-running process can drop the per-call rebuild
 * without touching the handler.
 */
export function kmsCosignerFactory(key: { kmsKeyId: string; region: string }): CosignerFactory {
  return () => new KmsSigner(new KMSClient({ region: key.region }), key.kmsKeyId);
}
