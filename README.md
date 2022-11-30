# gouda-parametrization-api

## Getting Started

follow [api-template README](https://github.com/Uniswap/api-template), specifically the _First time developing on AWS or with CDK?_ section to get your AWS CDK set up and bootstrapped.

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
