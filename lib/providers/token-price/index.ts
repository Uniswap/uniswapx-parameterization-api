import { Token } from '@uniswap/sdk-core';
import { USDC_ON } from '@uniswap/smart-order-router';
import axios from 'axios';
import { default as Logger } from 'bunyan';
import { BigNumber, ethers } from 'ethers';

export type BucketRange = {
  lower: BigNumber;
  upper: BigNumber;
};

export type TokenAmountsBucket = {
  bucketRange: BucketRange;
  lower: BigNumber;
  upper: BigNumber;
};

export interface TokenPriceProvider {
  getTokenPrice(token: Token): Promise<BigNumber>;
}

export class FallbackTokenPriceProvider implements TokenPriceProvider {
  private log: Logger;

  constructor(
    // @ts-expect-error
    private _log: Logger,
    protected chainId: number,
    protected endpoint: string
  ) {
    this.log = _log.child({ quoter: 'FallbackTokenPriceProvider' });
  }

  public async getTokenPrice(token: Token): Promise<BigNumber> {
    return await this.getUSDCRate(token);
  }

  public async getTokenAmountsForUSDCBucket(token: Token, bucket: BucketRange): Promise<TokenAmountsBucket> {
    const price = await this.getTokenPrice(token);
    return {
      bucketRange: bucket,
      lower: bucket.lower.mul(price),
      upper: bucket.upper.mul(price),
    };
  }

  private async getUSDCRate(token: Token): Promise<BigNumber> {
    const ONE_USDC = 10 ** 6; // USDC has 6 decimals across all chains
    const payload = {
      tokenIn: token.address,
      tokenInChainId: this.chainId,
      tokenOut: USDC_ON(this.chainId),
      tokenOutChainId: this.chainId,
      amount: ONE_USDC,
      type: 'EXACT_OUTPUT',
      configs: [
        {
          protocols: ['V2', 'V3', 'MIXED'],
          routingType: 'CLASSIC',
        },
      ],
    };
    const response = await axios.post<any>(this.endpoint, payload, {
      headers: {
        'content-type': 'application/json',
      },
    });

    this.log.info(response.data, 'Got USDC rate for token');

    return ethers.utils.parseUnits(response.data.quoteDecimals, token.decimals);
  }
}
