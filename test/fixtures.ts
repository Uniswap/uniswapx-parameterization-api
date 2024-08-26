import { MockV2CircuitBreakerConfigurationProvider } from '../lib/providers/circuit-breaker/mock';

const now = Math.floor(Date.now() / 1000);

export const WEBHOOK_URL = 'https://uniswap.org';
export const WEBHOOK_URL_ONEINCH = 'https://1inch.io';
export const WEBHOOK_URL_SEARCHER = 'https://searcher.com';

export const MOCK_V2_CB_PROVIDER = new MockV2CircuitBreakerConfigurationProvider(
  [WEBHOOK_URL, WEBHOOK_URL_ONEINCH, WEBHOOK_URL_SEARCHER],
  new Map([
    [WEBHOOK_URL_ONEINCH, { blockUntilTimestamp: now + 100000, lastPostTimestamp: now - 10, consecutiveBlocks: 0 }],
    [WEBHOOK_URL_SEARCHER, { blockUntilTimestamp: now - 10, lastPostTimestamp: now - 100, consecutiveBlocks: NaN }],
  ])
);
