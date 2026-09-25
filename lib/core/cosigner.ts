import { KMSClient } from '@aws-sdk/client-kms';
import { KmsSigner } from '@uniswap/signer';

import { checkDefined } from '../preconditions/preconditions';

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
 * Both the KMS config read and the client construction happen per call, exactly as they did
 * inline in the handler: a fresh KMSClient per request works around the SDK clock-skew bug
 * (https://github.com/aws/aws-sdk-js-v3/issues/6400), and a missing KMS_KEY_ID / REGION fails
 * the request rather than the container build. A long-running process can drop the per-call
 * rebuild without touching the handler.
 */
export function kmsCosignerFactory(): CosignerFactory {
  return () => {
    const kmsKeyId = checkDefined(process.env.KMS_KEY_ID, 'KMS_KEY_ID is not defined');
    const awsRegion = checkDefined(process.env.REGION, 'REGION is not defined');
    return new KmsSigner(new KMSClient({ region: awsRegion }), kmsKeyId);
  };
}
