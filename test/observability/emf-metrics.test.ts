import { createMetricsLogger, Unit } from 'aws-embedded-metrics';

import { Metric, metricContext } from '../../lib/entities/aws-metrics-logger';
import { EmfMetrics, Metrics } from '../../lib/observability';
import { FakeLogger } from '../fakes';

/**
 * Every metric the request path emitted through the smart-order-router IMetric before it moved to
 * ctx.metrics — the handlers, the recorder, getBestQuote, WebhookQuoter and the webhook config
 * provider — with the unit it used then. aws-embedded-metrics' Unit has the same strings as
 * smart-order-router's MetricLoggerUnit, so the tuple each Metrics call produces must be exactly
 * this one. Per-filler variants stand in for the metricContext family.
 */
const REQUEST_PATH_METRICS: { name: string; kind: keyof Metrics; value: number; unit: Unit }[] = [
  // handlers + posted-order recorder
  ...[
    Metric.QUOTE_REQUESTED,
    Metric.QUOTE_200,
    Metric.QUOTE_400,
    Metric.QUOTE_404,
    Metric.QUOTE_500,
    Metric.QUOTE_POST_ATTEMPT,
    Metric.QUOTE_POST_ERROR,
    Metric.POSTED_ORDER_RECORDED,
    Metric.POSTED_ORDER_RECORD_FAILED,
    Metric.FILLER_ADDRESS_RECORD_FAILED,
    Metric.FILLER_ADDRESS_CLAIM_REJECTED,
  ].map((name) => ({ name, kind: 'count' as const, value: 1, unit: Unit.Count })),
  { name: Metric.QUOTE_LATENCY, kind: 'timer', value: 187, unit: Unit.Milliseconds },
  { name: Metric.QUOTE_E2E_LATENCY, kind: 'timer', value: 0, unit: Unit.Milliseconds },
  { name: Metric.POSTED_ORDER_RECORD_LATENCY, kind: 'timer', value: 12, unit: Unit.Milliseconds },
  // getBestQuote, WebhookQuoter, webhook config provider
  ...[
    Metric.RFQ_COUNT_0,
    Metric.RFQ_COUNT_1,
    Metric.RFQ_COUNT_2,
    Metric.RFQ_COUNT_3,
    Metric.RFQ_COUNT_4_PLUS,
    Metric.RFQ_REQUESTED,
    Metric.RFQ_SUCCESS,
    Metric.RFQ_NON_QUOTE,
    Metric.RFQ_FAIL_VALIDATION,
    Metric.RFQ_FAIL_REQUEST_MATCH,
    Metric.RFQ_FAIL_ERROR,
    Metric.RFQ_TIMEOUT,
    Metric.RFQ_STRAGGLER,
    metricContext(Metric.RFQ_SUCCESS, 'filler'),
    metricContext(Metric.RFQ_STRAGGLER, 'filler'),
    Metric.RFQ_CONFIG_CHANGED,
  ].map((name) => ({ name, kind: 'count' as const, value: 1, unit: Unit.Count })),
  { name: Metric.RFQ_PHASE_ENDPOINT_STATUSES, kind: 'timer', value: 3, unit: Unit.Milliseconds },
  { name: Metric.RFQ_PHASE_FANOUT, kind: 'timer', value: 480, unit: Unit.Milliseconds },
  { name: Metric.RFQ_WASTED_WAIT, kind: 'timer', value: 0, unit: Unit.Milliseconds },
  { name: Metric.RFQ_RESPONSE_TIME, kind: 'timer', value: 212, unit: Unit.Milliseconds },
  { name: metricContext(Metric.RFQ_RESPONSE_TIME, 'filler'), kind: 'timer', value: 212, unit: Unit.Milliseconds },
];

/** A real aws-embedded-metrics logger with putMetric observed; the real validator still runs. */
function observedEmf() {
  const emf = createMetricsLogger();
  return {
    emf,
    putMetric: jest.spyOn(emf, 'putMetric'),
    setProperty: jest.spyOn(emf, 'setProperty'),
    putDimensions: jest.spyOn(emf, 'putDimensions'),
    setDimensions: jest.spyOn(emf, 'setDimensions'),
  };
}

describe('EmfMetrics', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(REQUEST_PATH_METRICS)(
    '$kind($name) reaches the MetricsLogger as the same (name, value, unit) the IMetric path emitted',
    async ({ name, kind, value, unit }) => {
      const { emf, putMetric } = observedEmf();
      const logger = new FakeLogger();
      await new EmfMetrics(emf, logger)[kind](name, value);

      expect(putMetric.mock.calls).toEqual([[name, value, unit]]);
      // The real validator accepted the tuple: nothing was dropped.
      expect(logger.records).toEqual([]);
    }
  );

  it('count defaults the value to 1, matching the putMetric(name, 1, Count) it replaces', async () => {
    const { emf, putMetric } = observedEmf();
    await new EmfMetrics(emf, new FakeLogger()).count(Metric.QUOTE_REQUESTED);
    expect(putMetric).toHaveBeenCalledTimes(1);
    expect(putMetric).toHaveBeenCalledWith(Metric.QUOTE_REQUESTED, 1, Unit.Count);
  });

  it('gauge emits unit None', async () => {
    const { emf, putMetric } = observedEmf();
    const logger = new FakeLogger();
    await new EmfMetrics(emf, logger).gauge('FADE_RATE', 0.25);
    expect(putMetric).toHaveBeenCalledWith('FADE_RATE', 0.25, Unit.None);
    expect(logger.records).toEqual([]);
  });

  it('accepts tags and dimensions without changing the tuple or touching properties or dimension sets', async () => {
    const { emf, putMetric, setProperty, putDimensions, setDimensions } = observedEmf();
    const metrics = new EmfMetrics(emf, new FakeLogger());

    await metrics.count(Metric.QUOTE_404, 1, { tags: ['status:failure', 'reason:no_quotes'] });
    await metrics.timer(Metric.QUOTE_LATENCY, 42, { tags: ['status:success'], dimensions: { chain: '1' } });

    expect(putMetric.mock.calls).toEqual([
      [Metric.QUOTE_404, 1, Unit.Count],
      [Metric.QUOTE_LATENCY, 42, Unit.Milliseconds],
    ]);
    // The injector owns the dimension sets; the adapter must not add to them (or to the EMF
    // blob's properties) on the way through.
    expect(setProperty).not.toHaveBeenCalled();
    expect(putDimensions).not.toHaveBeenCalled();
    expect(setDimensions).not.toHaveBeenCalled();
  });

  it('emits synchronously, so a void-ed call in a finally block has landed before the caller returns', () => {
    const { emf, putMetric } = observedEmf();
    const metrics = new EmfMetrics(emf, new FakeLogger());
    void metrics.timer(Metric.QUOTE_E2E_LATENCY, 5);
    expect(putMetric).toHaveBeenCalledWith(Metric.QUOTE_E2E_LATENCY, 5, Unit.Milliseconds);
  });

  it('logs and drops a metric the MetricsLogger rejects instead of throwing or rejecting into the request', async () => {
    const { emf } = observedEmf();
    // The IMetric path let this exception reach the handler (a 500 on the quote).
    expect(() => emf.putMetric(Metric.QUOTE_LATENCY, NaN, Unit.Milliseconds)).toThrow();

    const logger = new FakeLogger();
    const metrics = new EmfMetrics(emf, logger);
    await expect(metrics.timer(Metric.QUOTE_LATENCY, NaN)).resolves.toBeUndefined();
    await expect(metrics.count('   ')).resolves.toBeUndefined();

    const warnings = logger.atLevel('warn');
    expect(warnings).toHaveLength(2);
    expect(warnings[0].msg).toEqual('Dropped metric rejected by aws-embedded-metrics');
    expect(warnings[0].fields).toMatchObject({ metric: Metric.QUOTE_LATENCY, unit: Unit.Milliseconds });
    expect(warnings[0].fields.err).toBeInstanceOf(Error);
    expect(warnings[1].fields).toMatchObject({ metric: '   ', value: 1 });
    // Nothing else was logged: a healthy request path stays silent.
    expect(logger.records).toHaveLength(2);
  });
});
