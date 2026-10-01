import { Metric } from '../../../lib/entities';
import {
  AnalyticsLogLine,
  chunkForBatch,
  DirectQuoteAnalytics,
  FIREHOSE_MAX_BATCH_RECORDS,
  FIREHOSE_MAX_RECORD_BYTES,
  HARD_QUOTE_ANALYTICS_EVENT_TYPES,
  LOG_LINE_QUOTE_ANALYTICS,
  QUOTE_ANALYTICS_STREAM_ENV,
  QuoteAnalyticsEventType,
  selectQuoteAnalytics,
  SOFT_QUOTE_ANALYTICS_EVENT_TYPES,
} from '../../../lib/providers/analytics';
import { STAGE } from '../../../lib/util/stage';
import { FakeFirehoseBatchWriter, FakeLogger, FakeMetrics } from '../../fakes';

const STREAMS: Record<QuoteAnalyticsEventType, string> = {
  QuoteRequest: 'rfq-request-direct',
  QuoteResponse: 'rfq-response-direct',
  HardRequest: 'hard-request-direct',
  HardResponse: 'hard-response-direct',
};
const SOFT_STREAMS = { QuoteRequest: STREAMS.QuoteRequest, QuoteResponse: STREAMS.QuoteResponse };

function ctx() {
  return { logger: new FakeLogger(), metrics: new FakeMetrics(), requestId: 'req-1' };
}

/** Collects the log lines a sink wrote. */
function lineRecorder() {
  const lines: object[] = [];
  const writeLogLine: AnalyticsLogLine = (fields) => lines.push(fields);
  return { lines, writeLogLine };
}

function errnoError(code: string): Error {
  return Object.assign(new Error(`connect ${code} 1.2.3.4:443`), { code });
}

describe('LOG_LINE_QUOTE_ANALYTICS', () => {
  it('writes the record as its log line immediately, eventType first, and flush does nothing', async () => {
    const { lines, writeLogLine } = lineRecorder();
    LOG_LINE_QUOTE_ANALYTICS.record('QuoteRequest', { requestId: 'r' }, writeLogLine);
    expect(lines).toEqual([{ eventType: 'QuoteRequest', body: { requestId: 'r' } }]);
    expect(Object.keys(lines[0])).toEqual(['eventType', 'body']);
    await LOG_LINE_QUOTE_ANALYTICS.flush(ctx());
  });
});

describe('DirectQuoteAnalytics', () => {
  it('writes each record as its body JSON plus a newline, the shape the BigQuery load reads', async () => {
    const body = { requestId: 'r-1', amount: '1000000', type: 'EXACT_INPUT', nested: { a: [1, null, 'x'] } };
    const writer = new FakeFirehoseBatchWriter();
    const analytics = new DirectQuoteAnalytics(SOFT_STREAMS, writer);
    analytics.record('QuoteRequest', body, lineRecorder().writeLogLine);
    await analytics.flush(ctx());

    expect(writer.puts).toEqual([
      {
        streamName: STREAMS.QuoteRequest,
        records: ['{"requestId":"r-1","amount":"1000000","type":"EXACT_INPUT","nested":{"a":[1,null,"x"]}}\n'],
      },
    ]);
  });

  it('groups records by stream and sends nothing until flush', async () => {
    const writer = new FakeFirehoseBatchWriter();
    const analytics = new DirectQuoteAnalytics(SOFT_STREAMS, writer);
    const { lines, writeLogLine } = lineRecorder();
    analytics.record('QuoteRequest', { n: 1 }, writeLogLine);
    analytics.record('QuoteResponse', { n: 2 }, writeLogLine);
    analytics.record('QuoteResponse', { n: 3 }, writeLogLine);
    expect(writer.puts).toHaveLength(0);

    const c = ctx();
    await analytics.flush(c);
    expect(writer.puts).toEqual([
      { streamName: STREAMS.QuoteRequest, records: ['{"n":1}\n'] },
      { streamName: STREAMS.QuoteResponse, records: ['{"n":2}\n', '{"n":3}\n'] },
    ]);
    expect(lines).toEqual([]);
    expect(c.metrics.values(Metric.QUOTE_ANALYTICS_RECORDS_SENT)).toEqual([3]);
    expect(c.metrics.emitted(Metric.QUOTE_ANALYTICS_FLUSH_LATENCY)).toEqual(1);
  });

  it('drains the queue, so a second flush sends only what was recorded since', async () => {
    const writer = new FakeFirehoseBatchWriter();
    const analytics = new DirectQuoteAnalytics(SOFT_STREAMS, writer);
    analytics.record('QuoteRequest', { n: 1 }, lineRecorder().writeLogLine);
    await analytics.flush(ctx());
    const c = ctx();
    await analytics.flush(c);
    expect(writer.puts).toHaveLength(1);
    expect(c.metrics.names()).toEqual([]);
  });

  it('keeps a log line, and sends nothing, for record types this Lambda does not load', async () => {
    // The hard-quote Lambda produces QuoteResponse records for opposing-side responses; they were
    // never loaded, so the sink must not start writing them.
    const writer = new FakeFirehoseBatchWriter();
    const analytics = new DirectQuoteAnalytics(
      { HardRequest: STREAMS.HardRequest, HardResponse: STREAMS.HardResponse },
      writer
    );
    const { lines, writeLogLine } = lineRecorder();
    analytics.record('QuoteResponse', { n: 1 }, writeLogLine);
    expect(lines).toEqual([{ eventType: 'QuoteResponse', body: { n: 1 } }]);
    await analytics.flush(ctx());
    expect(writer.puts).toEqual([]);
  });

  it('writes a body JSON cannot serialize as its log line instead of throwing', async () => {
    const writer = new FakeFirehoseBatchWriter();
    const analytics = new DirectQuoteAnalytics(SOFT_STREAMS, writer);
    const { lines, writeLogLine } = lineRecorder();
    const unserializable: Record<string, unknown> = { amount: BigInt(1) };
    expect(() => analytics.record('QuoteRequest', unserializable, writeLogLine)).not.toThrow();
    expect(lines).toEqual([{ eventType: 'QuoteRequest', body: unserializable }]);
    await analytics.flush(ctx());
    expect(writer.puts).toEqual([]);
  });

  it('drops and counts records Firehose refused, and only those', async () => {
    const writer = new FakeFirehoseBatchWriter({
      [STREAMS.QuoteResponse]: [undefined, 'ServiceUnavailableException', undefined],
    });
    const analytics = new DirectQuoteAnalytics(SOFT_STREAMS, writer);
    const { lines, writeLogLine } = lineRecorder();
    [1, 2, 3].forEach((n) => analytics.record('QuoteResponse', { n }, writeLogLine));
    const c = ctx();
    await analytics.flush(c);
    expect(lines).toEqual([]);
    expect(c.metrics.values(Metric.QUOTE_ANALYTICS_RECORDS_SENT)).toEqual([2]);
    expect(c.metrics.calls.filter((m) => m.name === Metric.QUOTE_ANALYTICS_RECORDS_DROPPED)).toEqual([
      expect.objectContaining({ value: 1, opts: { tags: ['status:failure', 'reason:rejected'] } }),
    ]);
    expect(c.logger.atLevel('warn')).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({ failedPutCount: 1, errorCodes: { ServiceUnavailableException: 1 } }),
      }),
    ]);
  });

  it('drops and counts the whole batch when the put fails, never re-sending it', async () => {
    const writer = new FakeFirehoseBatchWriter({ [STREAMS.QuoteRequest]: errnoError('ECONNRESET') });
    const analytics = new DirectQuoteAnalytics(SOFT_STREAMS, writer);
    const { lines, writeLogLine } = lineRecorder();
    analytics.record('QuoteRequest', { n: 1 }, writeLogLine);
    analytics.record('QuoteRequest', { n: 2 }, writeLogLine);
    analytics.record('QuoteResponse', { n: 3 }, writeLogLine);
    const c = ctx();
    await analytics.flush(c);
    expect(lines).toEqual([]);
    expect(c.metrics.calls.filter((m) => m.name === Metric.QUOTE_ANALYTICS_RECORDS_DROPPED)).toEqual([
      expect.objectContaining({ value: 2, opts: { tags: ['status:failure', 'reason:request_failed'] } }),
    ]);
    expect(c.metrics.values(Metric.QUOTE_ANALYTICS_RECORDS_SENT)).toEqual([1]);
    expect(writer.puts.filter((p) => p.streamName === STREAMS.QuoteRequest)).toHaveLength(1);
    expect(c.logger.atLevel('warn')).toHaveLength(1);
  });

  it('drops and counts an oversized record without sending it', async () => {
    const writer = new FakeFirehoseBatchWriter();
    const analytics = new DirectQuoteAnalytics(SOFT_STREAMS, writer);
    const { lines, writeLogLine } = lineRecorder();
    analytics.record('QuoteResponse', { blob: 'x'.repeat(FIREHOSE_MAX_RECORD_BYTES) }, writeLogLine);
    analytics.record('QuoteResponse', { n: 1 }, writeLogLine);
    const c = ctx();
    await analytics.flush(c);
    expect(lines).toEqual([]);
    expect(writer.puts).toEqual([{ streamName: STREAMS.QuoteResponse, records: ['{"n":1}\n'] }]);
    expect(c.metrics.calls.find((m) => m.name === Metric.QUOTE_ANALYTICS_RECORDS_DROPPED)?.opts).toEqual({
      tags: ['status:failure', 'reason:too_large'],
    });
  });

  it('never throws from flush, whatever the writer does', async () => {
    const writer = new FakeFirehoseBatchWriter({ [STREAMS.QuoteRequest]: new Error('boom') });
    const analytics = new DirectQuoteAnalytics(SOFT_STREAMS, writer);
    analytics.record('QuoteRequest', { n: 1 }, () => undefined);
    await expect(analytics.flush(ctx())).resolves.toBeUndefined();
  });
});

describe('chunkForBatch', () => {
  const rec = (bytes: number) => ({ data: new Uint8Array(bytes) });

  it('caps each chunk at the PutRecordBatch record limit', () => {
    const chunks = chunkForBatch(Array.from({ length: FIREHOSE_MAX_BATCH_RECORDS + 1 }, () => rec(10)));
    expect(chunks.map((c) => c.length)).toEqual([FIREHOSE_MAX_BATCH_RECORDS, 1]);
  });

  it('caps each chunk at the PutRecordBatch size limit', () => {
    const chunks = chunkForBatch([rec(900 * 1024), rec(900 * 1024), rec(900 * 1024), rec(900 * 1024), rec(900 * 1024)]);
    expect(chunks.map((c) => c.length)).toEqual([4, 1]);
  });

  it('returns no chunks for no records', () => {
    expect(chunkForBatch([])).toEqual([]);
  });
});

describe('selectQuoteAnalytics', () => {
  const log = () => ({ info: jest.fn() });
  const directEnv = (types: readonly QuoteAnalyticsEventType[]): Partial<Record<QuoteAnalyticsEventType, string>> =>
    Object.fromEntries(types.map((t) => [t, STREAMS[t]]));

  it('logs records on the local stack, which has no streams', () => {
    expect(selectQuoteAnalytics(log(), STAGE.LOCAL, SOFT_QUOTE_ANALYTICS_EVENT_TYPES, {})).toBe(
      LOG_LINE_QUOTE_ANALYTICS
    );
  });

  it('goes direct when every stream name is set', () => {
    const env = directEnv(SOFT_QUOTE_ANALYTICS_EVENT_TYPES);
    const writer = new FakeFirehoseBatchWriter();
    expect(selectQuoteAnalytics(log(), STAGE.PROD, SOFT_QUOTE_ANALYTICS_EVENT_TYPES, env, () => writer)).toBeInstanceOf(
      DirectQuoteAnalytics
    );
  });

  it("routes only the Lambda's own record types to the named streams", async () => {
    const writer = new FakeFirehoseBatchWriter();
    const env = directEnv([...SOFT_QUOTE_ANALYTICS_EVENT_TYPES, ...HARD_QUOTE_ANALYTICS_EVENT_TYPES]);
    const analytics = selectQuoteAnalytics(log(), STAGE.BETA, HARD_QUOTE_ANALYTICS_EVENT_TYPES, env, () => writer);
    for (const t of ['QuoteRequest', 'QuoteResponse', 'HardRequest', 'HardResponse'] as const) {
      analytics.record(t, { t }, () => undefined);
    }
    await analytics.flush(ctx());
    expect(writer.puts.map((p) => p.streamName)).toEqual([STREAMS.HardRequest, STREAMS.HardResponse]);
  });

  it('fails the build, naming what is missing, when a deployed stage lacks stream names', () => {
    expect(() => selectQuoteAnalytics(log(), STAGE.PROD, SOFT_QUOTE_ANALYTICS_EVENT_TYPES, {})).toThrow(
      QUOTE_ANALYTICS_STREAM_ENV.QuoteRequest
    );
  });

  it('fails the build when only some stream names are set, on any stage', () => {
    for (const stage of [STAGE.LOCAL, STAGE.BETA]) {
      expect(() =>
        selectQuoteAnalytics(log(), stage, SOFT_QUOTE_ANALYTICS_EVENT_TYPES, directEnv(['QuoteRequest']))
      ).toThrow(QUOTE_ANALYTICS_STREAM_ENV.QuoteResponse);
    }
  });
});
