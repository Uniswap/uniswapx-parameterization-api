import { ethers, Wallet } from 'ethers';

import { Cosigner, CosignerFactory } from '../../lib/handlers/hard-quote/cosigner';

/**
 * A cosigner backed by a local wallet, standing in for the KMS key. It signs digests the way
 * KmsSigner does (an EIP-191 signature over the raw digest bytes), so cosigned orders parse and
 * verify exactly as in production, and wallets built from a fixed private key keep signatures
 * deterministic for snapshots.
 */
export class FakeCosigner implements Cosigner {
  public readonly signedDigests: (Buffer | string)[] = [];

  constructor(private readonly wallet: Wallet) {}

  public async getAddress(): Promise<string> {
    return this.wallet.address;
  }

  public async signDigest(digest: Buffer | string): Promise<string> {
    this.signedDigests.push(digest);
    return this.wallet.signMessage(ethers.utils.arrayify(digest));
  }

  /** A factory that hands out this same cosigner on every request. */
  public factory(): CosignerFactory {
    return () => this;
  }
}
