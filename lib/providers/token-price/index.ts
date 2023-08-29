// import { BigNumber, ethers } from "ethers";
// import { default as Logger } from 'bunyan';
// import { Token } from "@uniswap/sdk-core";
// import { TokenPriceProvider } from "./fallback-token-price-provider";

// export type BucketRange = {
//     lower: BigNumber;
//     upper: BigNumber;
// }

// export type TokenAmountsBucket = {
//     bucketRange: BucketRange 
//     lower: BigNumber;
//     upper: BigNumber;
// }

// const tokenPriceQuery = gql`
//   query TokenPrice($chain: Chain!, $address: String = null, $duration: HistoryDuration!) {
//     token(chain: $chain, address: $address) {
//       id
//       address
//       chain
//       market(currency: USD) {
//         id
//         price {
//           id
//           value
//         }
//         priceHistory(duration: $duration) {
//           id
//           timestamp
//           value
//         }
//       }
//     }
//   }
// `

// export class TokenPriceProviderWithFallback {
//     private client: ApolloClient<any>;
//     private log: Logger;

//     constructor(
//         private _log: Logger,
//         protected chainId: number,
//         protected graphqlUrl: string,
//         protected fallbackTokenPriceProvider: TokenPriceProvider,
//     ) {
//         this.log = _log.child({ quoter: 'TokenPriceProviderWithFallback' });
//         this.client = new ApolloClient({
//             uri: graphqlUrl,
//             headers: {
//                 'Content-Type': 'application/json',
//                 Origin: 'https://app.uniswap.org',
//               },
//               cache: new InMemoryCache(),
//         })
//     }

//     public async getPrices(tokens: Token[]): Promise<(BigNumber | undefined)[]> {
//         const calls = tokens.map(token => {
//             return this.getPrice(token)
//         });
//         const results = await Promise.allSettled(calls);
//         const prices = results.map(result => {
//             if (result.status === 'fulfilled') {
//                 return result.value;
//             } else {
//                 this.log.info(`Failed to get price for token: ${result.reason}`)
//                 return undefined;
//             }
//         });
//         return prices;
//     }

//     public async getPrice(token: Token): Promise<BigNumber> {
//         const price = await this.getTokenPriceFromGraphQL(token.address);
//         if (!price) {
//             return await this.fallbackTokenPriceProvider.getTokenPrice(token);
//         }
//         return ethers.utils.parseUnits(price.toString(), token.decimals);
//     }

//     public async getTokenPriceFromGraphQL(address: string): Promise<number | undefined> {
//         const result = await this.client.query({
//             query: tokenPriceQuery,
//             variables: {
//                 chain: this.chainId,
//                 address: address,
//                 duration: 'DAY',
//             },
//         })
//         if (result.data.token === null) {
//             this.log.info(`Failed to get price for token: ${address}`)
//             return undefined;
//         }
//         return result.data.token.market.price.value;
//     }
// }