import { isTestRun, loadCircuitBreakerConfig, loadHardQuoteConfig, loadQuoteConfig } from '../lib/config';
import { QUOTE_ANALYTICS_STREAM_ENV } from '../lib/providers/analytics';
import { STAGE } from '../lib/util/stage';

const QUOTE_ENV = {
  stage: 'prod',
  RPC_PREFIX_URL: 'https://rpc.example/',
  RPC_HEADER_SECRET: 'secret',
  ANALYTICS_STREAM_ARN: 'arn:aws:firehose:us-east-2:123456789012:deliverystream/AnalyticsEventsStream',
};
const HARD_ENV = {
  ...QUOTE_ENV,
  ORDER_SERVICE_URL: 'https://orders.example/',
  KMS_KEY_ID: 'key-id',
  REGION: 'us-east-2',
};
const CRON_ENV = { stage: 'beta', ORDER_SERVICE_URL: 'https://orders.example/' };

describe('loadQuoteConfig', () => {
  it('reads the shared quote config', () => {
    expect(
      loadQuoteConfig({
        ...QUOTE_ENV,
        EGRESS_PROXY_URL: 'http://proxy.example:3128',
        EGRESS_PROXY_WEBHOOK_SHARE_PERCENT: '100',
        [QUOTE_ANALYTICS_STREAM_ENV.QuoteRequest]: 'rfq-request',
        [QUOTE_ANALYTICS_STREAM_ENV.QuoteResponse]: 'rfq-response',
      })
    ).toEqual({
      stage: STAGE.PROD,
      rpc: { prefixUrl: 'https://rpc.example/', headerSecret: 'secret' },
      webhookResponseStreamArn: QUOTE_ENV.ANALYTICS_STREAM_ARN,
      egressProxy: { url: 'http://proxy.example:3128', rawShare: '100' },
      quoteAnalyticsStreams: { QuoteRequest: 'rfq-request', QuoteResponse: 'rfq-response' },
    });
  });

  it('treats empty optional values as unset (the local stack sets them to "")', () => {
    const config = loadQuoteConfig({ ...QUOTE_ENV, RPC_HEADER_SECRET: '', EGRESS_PROXY_URL: '' });
    expect(config.rpc.headerSecret).toBeUndefined();
    expect(config.egressProxy.url).toBeUndefined();
    expect(config.quoteAnalyticsStreams).toEqual({});
  });

  it.each([['stage'], ['RPC_PREFIX_URL'], ['ANALYTICS_STREAM_ARN']])('fails without %s', (name) => {
    expect(() => loadQuoteConfig({ ...QUOTE_ENV, [name]: undefined })).toThrow(`${name} is not set`);
    expect(() => loadQuoteConfig({ ...QUOTE_ENV, [name]: '' })).toThrow(`${name} is not set`);
  });

  it('fails on an unknown stage, a non-URL RPC prefix, or a non-Firehose stream ARN', () => {
    expect(() => loadQuoteConfig({ ...QUOTE_ENV, stage: 'production' })).toThrow('stage must be one of');
    expect(() => loadQuoteConfig({ ...QUOTE_ENV, RPC_PREFIX_URL: 'rpc.example' })).toThrow('not a valid URL');
    expect(() => loadQuoteConfig({ ...QUOTE_ENV, RPC_PREFIX_URL: 'ftp://rpc.example' })).toThrow('http(s) URL');
    expect(() => loadQuoteConfig({ ...QUOTE_ENV, ANALYTICS_STREAM_ARN: 'stream' })).toThrow('Firehose');
  });
});

describe('loadHardQuoteConfig', () => {
  it('adds the order service and the cosigner key', () => {
    const config = loadHardQuoteConfig(HARD_ENV);
    expect(config.orderServiceUrl).toEqual('https://orders.example/');
    expect(config.cosigner).toEqual({ kmsKeyId: 'key-id', region: 'us-east-2' });
    expect(config.stage).toEqual(STAGE.PROD);
  });

  it.each([['ORDER_SERVICE_URL'], ['KMS_KEY_ID'], ['REGION']])('fails without %s', (name) => {
    expect(() => loadHardQuoteConfig({ ...HARD_ENV, [name]: undefined })).toThrow(`${name} is not set`);
  });
});

describe('loadCircuitBreakerConfig', () => {
  it('reads the cron config, with the policy flag off by default', () => {
    expect(loadCircuitBreakerConfig(CRON_ENV)).toEqual({
      stage: STAGE.BETA,
      orderServiceUrl: 'https://orders.example/',
      countNeverFilledTerminalAsFade: false,
    });
  });

  it("accepts only 'true' or 'false' for the policy flag", () => {
    const flag = (value: string) =>
      loadCircuitBreakerConfig({ ...CRON_ENV, FADES_COUNT_NEVER_FILLED_TERMINAL_AS_FADE: value });
    expect(flag('true').countNeverFilledTerminalAsFade).toBe(true);
    expect(flag('false').countNeverFilledTerminalAsFade).toBe(false);
    expect(() => flag('yes')).toThrow("must be 'true' or 'false'");
  });

  it.each([['stage'], ['ORDER_SERVICE_URL']])('fails without %s', (name) => {
    expect(() => loadCircuitBreakerConfig({ ...CRON_ENV, [name]: undefined })).toThrow(`${name} is not set`);
  });
});

describe('isTestRun', () => {
  it('is true only under NODE_ENV=test', () => {
    expect(isTestRun({ NODE_ENV: 'test' })).toBe(true);
    expect(isTestRun({ NODE_ENV: 'production' })).toBe(false);
    expect(isTestRun({})).toBe(false);
  });
});
