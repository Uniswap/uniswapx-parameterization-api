import { MetricLoggerUnit } from '@uniswap/smart-order-router';
import { createMetricsLogger } from 'aws-embedded-metrics';

import { AWSMetricsLogger, Metric } from '../../lib/entities/aws-metrics-logger';
import { EmfMetrics, Metrics } from '../../lib/observability';
import { FakeLogger } from '../fakes';

/**
 * Every metric the handler layer (quote/handler.ts, hard-quote/handler.ts,
 * posted-order-recorder.ts) emitted through the smart-order-router IMetric before it moved to
 * ctx.metrics, with the unit it used then. The equivalence test asserts that the Metrics call
 * each one became reaches the request's MetricsLogger as the identical (name, value, unit).
 */
const HANDLER_METRICS: { name: Metric; kind: keyof Metrics; value: number; unit: MetricLoggerUnit }[] = [
  { name: Metric.QUOTE_REQUESTED, kind: 'count', value: 1, unit: MetricLoggerUnit.Count },
  { name: Metric.QUOTE_200, kind: 'count', value: 1, unit: MetricLoggerUnit.Count },
  { name: Metric.QUOTE_400, kind: 'count', value: 1, unit: MetricLoggerUnit.Count },
  { name: Metric.QUOTE_404, kind: 'count', value: 1, unit: MetricLoggerUnit.Count },
  { name: Metric.QUOTE_500, kind: 'count', value: 1, unit: MetricLoggerUnit.Count },
  { name: Metric.QUOTE_POST_ATTEMPT, kind: 'count', value: 1, unit: MetricLoggerUnit.Count },
  { name: Metric.QUOTE_POST_ERROR, kind: 'count', value: 1, unit: MetricLoggerUnit.Count },
  { name: Metric.POSTED_ORDER_RECORDED, kind: 'count', value: 1, unit: MetricLoggerUnit.Count },
  { name: Metric.POSTED_ORDER_RECORD_FAILED, kind: 'count', value: 1, unit: MetricLoggerUnit.Count },
  { name: Metric.FILLER_ADDRESS_RECORD_FAILED, kind: 'count', value: 1, unit: MetricLoggerUnit.Count },
  { name: Metric.FILLER_ADDRESS_CLAIM_REJECTED, kind: 'count', value: 1, unit: MetricLoggerUnit.Count },
  { name: Metric.QUOTE_LATENCY, kind: 'timer', value: 187, unit: MetricLoggerUnit.Milliseconds },
  { name: Metric.QUOTE_E2E_LATENCY, kind: 'timer', value: 0, unit: MetricLoggerUnit.Milliseconds },
  { name: Metric.POSTED_ORDER_RECORD_LATENCY, kind: 'timer', value: 12, unit: MetricLoggerUnit.Milliseconds },
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

  it.each(HANDLER_METRICS)(
    '$kind($name) reaches the MetricsLogger as the same (name, value, unit) the IMetric path emitted',
    async ({ name, kind, value, unit }) => {
      const before = observedEmf();
      new AWSMetricsLogger(before.emf).putMetric(name, value, unit);

      const after = observedEmf();
      const logger = new FakeLogger();
      await new EmfMetrics(after.emf, logger)[kind](name, value);

      expect(after.putMetric.mock.calls).toEqual(before.putMetric.mock.calls);
      expect(after.putMetric).toHaveBeenCalledWith(name, value, unit);
      // The real validator accepted the tuple: nothing was dropped.
      expect(logger.records).toEqual([]);
    }
  );

  it('count defaults the value to 1, matching the putMetric(name, 1, Count) it replaces', async () => {
    const { emf, putMetric } = observedEmf();
    await new EmfMetrics(emf, new FakeLogger()).count(Metric.QUOTE_REQUESTED);
    expect(putMetric).toHaveBeenCalledTimes(1);
    expect(putMetric).toHaveBeenCalledWith(Metric.QUOTE_REQUESTED, 1, MetricLoggerUnit.Count);
  });

  it('gauge emits unit None', async () => {
    const { emf, putMetric } = observedEmf();
    const logger = new FakeLogger();
    await new EmfMetrics(emf, logger).gauge('FADE_RATE', 0.25);
    expect(putMetric).toHaveBeenCalledWith('FADE_RATE', 0.25, MetricLoggerUnit.None);
    expect(logger.records).toEqual([]);
  });

  it('accepts tags and dimensions without changing the tuple or touching properties or dimension sets', async () => {
    const { emf, putMetric, setProperty, putDimensions, setDimensions } = observedEmf();
    const metrics = new EmfMetrics(emf, new FakeLogger());

    await metrics.count(Metric.QUOTE_404, 1, { tags: ['status:failure', 'reason:no_quotes'] });
    await metrics.timer(Metric.QUOTE_LATENCY, 42, { tags: ['status:success'], dimensions: { chain: '1' } });

    expect(putMetric.mock.calls).toEqual([
      [Metric.QUOTE_404, 1, MetricLoggerUnit.Count],
      [Metric.QUOTE_LATENCY, 42, MetricLoggerUnit.Milliseconds],
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
    expect(putMetric).toHaveBeenCalledWith(Metric.QUOTE_E2E_LATENCY, 5, MetricLoggerUnit.Milliseconds);
  });

  it('logs and drops a metric the MetricsLogger rejects instead of throwing or rejecting into the request', async () => {
    const { emf } = observedEmf();
    // The IMetric path let this exception reach the handler (a 500 on the quote).
    expect(() => emf.putMetric(Metric.QUOTE_LATENCY, NaN, MetricLoggerUnit.Milliseconds)).toThrow();

    const logger = new FakeLogger();
    const metrics = new EmfMetrics(emf, logger);
    await expect(metrics.timer(Metric.QUOTE_LATENCY, NaN)).resolves.toBeUndefined();
    await expect(metrics.count('   ')).resolves.toBeUndefined();

    const warnings = logger.atLevel('warn');
    expect(warnings).toHaveLength(2);
    expect(warnings[0].msg).toEqual('Dropped metric rejected by aws-embedded-metrics');
    expect(warnings[0].fields).toMatchObject({ metric: Metric.QUOTE_LATENCY, unit: MetricLoggerUnit.Milliseconds });
    expect(warnings[0].fields.err).toBeInstanceOf(Error);
    expect(warnings[1].fields).toMatchObject({ metric: '   ', value: 1 });
    // Nothing else was logged: a healthy request path stays silent.
    expect(logger.records).toHaveLength(2);
  });
});
