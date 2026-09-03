import { aws_lambda_nodejs } from 'aws-cdk-lib';

/**
 * esbuild options shared by every NodejsFunction in this app.
 *
 * `externalModules` replaces CDK's default (`@aws-sdk/*`, provided by the Node 18+ runtimes), so that
 * default is restated here. `source-map-support` is excluded on purpose: nothing in this repo depends
 * on it, but bunyan does an optional `require('source-map-support')` behind a try/catch (used only when
 * a logger is created with `src: true`, which we never do). Left bundleable, whichever copy happens to
 * be hoisted by dev tooling gets baked into the production bundles and changes their asset hash on
 * unrelated dependency PRs. Externalizing it makes bunyan's require throw at runtime, which its
 * try/catch swallows, so the deployed behaviour is unchanged minus the dead code.
 */
export const LAMBDA_BUNDLING: aws_lambda_nodejs.BundlingOptions = {
  minify: true,
  sourceMap: true,
  externalModules: ['@aws-sdk/*', 'source-map-support'],
};
