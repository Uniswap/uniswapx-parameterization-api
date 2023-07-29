# uniswapx-parametrization-api

[![Unit Tests](https://github.com/Uniswap/uniswapx-parameterization-api/actions/workflows/test.yml/badge.svg)](https://github.com/Uniswap/uniswapx-parameterization-api/actions/workflows/test.yml)

UniswapX Parameterization API is a service to parameterize UniswapX orders. The service fetches quotes on-demand from external providers to get a sense of the current market price for a given trade.

## Getting Started

follow [api-template README](https://github.com/Uniswap/api-template#first-time-developing-on-aws-or-with-cdk) to get your AWS CDK set up and bootstrapped.

To run dynamodb-related tests, you need to have Java Runtime installed (https://www.java.com/en/download/manual.jsp).

## Delopyment

### Dev Environment

To deploy to your own AWS account,

```
yarn && yarn build
```

then

```
cdk deploy
```

after successful deployment, you should see something like

```
 ✅  GoudaParameterizationStack

✨  Deployment time: 93.78s

Outputs:
GoudaParameterizationStack.GoudaParameterizationEndpoint57A27B25 = <your dev url>
GoudaParameterizationStack.Url = <your dev url>
```

The project currently has a `GET hello-world` Api Gateway<>Lambda integration set up:

```
❯ curl <url>/prod/quote/hello-world
"hello world"%
```

## Integration Tests

1. Deploy your API using the intructions above.

1. Add your API url to your `.env` file as `UNISWAP_API`

   ```
   UNISWAP_API='<YourUrl>'
   ```

1. Run the tests with:
   ```
   yarn test:integ
   ```

## Webhook Quoting Schema

Quoters will need to abide by the following schemas in order to successfully quote UniswapX orders.

### Request

This data will be included in the body of the request and will be sent to the given quote endpoint.

```
{
   tokenInChainId: number,
   tokenOutChainId: number,
   requestId: string,
   tokenIn: string,
   tokenOut: string,
   amount: string,
   swapper: string,
   type: string (ex. EXACT_INPUT or EXACT_OUTPUT),
}
```

### Response

This data will be expected in the body of the quote response.

_Note: if a quoter elects to not quote a swap they should still send back a response but with a zero value in the `amountIn`/`amountOut` field, depending on the trade type._

```
{
  chainId: number,
  requestId: number,
  tokenIn: string,
  amountIn: string,
  tokenOut: string,
  amountOut: string,
  filler: string,
}
```

The `requestId`, `tokenIn`, `chainId`, `tokenIn`, and `tokenOut` fields should be mirrored from the request. The `filler` address should be the address of the fill contract.
