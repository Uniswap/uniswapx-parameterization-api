# uniswapx-parametrization-api

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
