// IMPORANT: Once this has been changed once from the original value of 'Template',
// do not change again. Changing would cause every piece of infrastructure to change
// name, and thus be redeployed. Should be camel case and contain no non-alphanumeric characters.
export const SERVICE_NAME = 'GoudaParameterization';

// Backend monorepo AWS accounts that run the GPA service (package `uniswapx`). They sign hard
// quotes with this stack's cosigner key cross-account; see HARD_QUOTE_COSIGNER_BACKEND_ACCOUNTS
// in ./config for which account may use which stage's key.
export const BACKEND_DEV_ACCOUNT = '411170392337'; // backend `dev`
export const BACKEND_STAGING_ACCOUNT = '413367642260'; // backend `staging`
export const BACKEND_PROD_ACCOUNT = '654200013602'; // backend `prod`

// The backend service's ECS task role is `<serviceShortName>-ecsTaskRole` plus a Pulumi suffix, i.e.
// `uniswapx-ecsTaskRole-<suffix>`. Same pattern the gouda-account roles trust (uniswapx-service #714).
// Not the wider `uniswapx-*`: that would let any other `uniswapx-` role in those accounts sign quotes.
export const BACKEND_COSIGNER_ROLE_NAME_PATTERN = 'uniswapx-ecsTaskRole-*';
