import { default as bunyan } from 'bunyan';
import { Writable } from 'stream';

import { Metric } from '../../../lib/entities';
import { transformLogEvent } from '../../../lib/handlers/blueprints/transformations';
import {
  AnalyticsLogLine,
  chunkForBatch,
  DirectQuoteAnalytics,
  FIREHOSE_MAX_BATCH_RECORDS,
  FIREHOSE_MAX_RECORD_BYTES,
  HARD_QUOTE_ANALYTICS_EVENT_TYPES,
  isAmbiguousTimeout,
  LOG_LINE_QUOTE_ANALYTICS,
  QUOTE_ANALYTICS_STREAM_ENV,
  QuoteAnalyticsEventType,
  selectQuoteAnalytics,
  SOFT_QUOTE_ANALYTICS_EVENT_TYPES,
} from '../../../lib/providers/analytics';
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

/** Collects what each record's log-line fallback wrote. */
function lineRecorder() {
  const lines: object[] = [];
  const writeLogLine: AnalyticsLogLine = (fields) => lines.push(fields);
  return { lines, writeLogLine };
}

function timeoutError(message: string): Error {
  return Object.assign(new Error(message), { name: 'TimeoutError' });
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
  it('writes each record as its body JSON plus a newline, byte-identical to what the log path produces', async () => {
    // A real bunyan line through the log-driven path's transform, for the same body.
    const body = { requestId: 'r-1', amount: '1000000', type: 'EXACT_INPUT', nested: { a: [1, null, 'x'] } };
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        chunks.push(chunk.toString());
        done();
      },
    });
    const log = bunyan.createLogger({ name: 'test', streams: [{ stream: sink }] });
    LOG_LINE_QUOTE_ANALYTICS.record('QuoteRequest', body, (fields) => log.info(fields));
    const transformed = transformLogEvent({ message: chunks[0].trimEnd() });

    const writer = new FakeFirehoseBatchWriter();
    const analytics = new DirectQuoteAnalytics(SOFT_STREAMS, writer);
    analytics.record('QuoteRequest', body, lineRecorder().writeLogLine);
    await analytics.flush(ctx());

    expect(writer.puts).toEqual([{ streamName: STREAMS.QuoteRequest, records: [transformed + '\n'] }]);
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

  it("skips record types this Lambda's subscription filters never carried, writing no log line either", async () => {
    // The hard-quote Lambda logs QuoteResponse lines for opposing-side responses; no filter on its
    // log group forwards them, so the direct path must not start writing them.
    const writer = new FakeFirehoseBatchWriter();
    const analytics = new DirectQuoteAnalytics(
      { HardRequest: STREAMS.HardRequest, HardResponse: STREAMS.HardResponse },
      writer
    );
    const { lines, writeLogLine } = lineRecorder();
    analytics.record('QuoteResponse', { n: 1 }, writeLogLine);
    await analytics.flush(ctx());
    expect(writer.puts).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('writes records Firehose refused as their log line, and only those', async () => {
    const writer = new FakeFirehoseBatchWriter({ [STREAMS.QuoteResponse]: [false, true, false] });
    const analytics = new DirectQuoteAnalytics(SOFT_STREAMS, writer);
    const { lines, writeLogLine } = lineRecorder();
    [1, 2, 3].forEach((n) => analytics.record('QuoteResponse', { n }, writeLogLine));
    const c = ctx();
    await analytics.flush(c);
    expect(lines).toEqual([{ eventType: 'QuoteResponse', body: { n: 2 } }]);
    expect(c.metrics.values(Metric.QUOTE_ANALYTICS_RECORDS_SENT)).toEqual([2]);
    const fallback = c.metrics.calls.filter((m) => m.name === Metric.QUOTE_ANALYTICS_RECORDS_FALLBACK);
    expect(fallback).toEqual([
      expect.objectContaining({ value: 1, opts: { tags: ['status:failure', 'reason:rejected'] } }),
    ]);
  });

  it('writes the whole batch as log lines when the put fails before reaching Firehose', async () => {
    for (const error of [
      Object.assign(new Error('Stream not found'), { name: 'ResourceNotFoundException' }),
      timeoutError('Socket timed out without establishing a connection within 300 ms'),
    ]) {
      const writer = new FakeFirehoseBatchWriter({ [STREAMS.QuoteRequest]: error });
      const analytics = new DirectQuoteAnalytics(SOFT_STREAMS, writer);
      const { lines, writeLogLine } = lineRecorder();
      analytics.record('QuoteRequest', { n: 1 }, writeLogLine);
      analytics.record('QuoteRequest', { n: 2 }, writeLogLine);
      const c = ctx();
      await analytics.flush(c);
      expect(lines).toEqual([
        { eventType: 'QuoteRequest', body: { n: 1 } },
        { eventType: 'QuoteRequest', body: { n: 2 } },
      ]);
      expect(c.metrics.values(Metric.QUOTE_ANALYTICS_RECORDS_FALLBACK)).toEqual([2]);
      expect(c.logger.atLevel('warn')).toHaveLength(1);
    }
  });

  it('drops and counts records when the put timed out after connecting, never re-sending them', async () => {
    const writer = new FakeFirehoseBatchWriter({
      [STREAMS.QuoteRequest]: timeoutError('Connection timed out after 500 ms'),
    });
    const analytics = new DirectQuoteAnalytics(SOFT_STREAMS, writer);
    const { lines, writeLogLine } = lineRecorder();
    analytics.record('QuoteRequest', { n: 1 }, writeLogLine);
    analytics.record('QuoteResponse', { n: 2 }, writeLogLine);
    const c = ctx();
    await analytics.flush(c);
    expect(lines).toEqual([]);
    expect(c.metrics.values(Metric.QUOTE_ANALYTICS_RECORDS_DROPPED)).toEqual([1]);
    expect(c.metrics.values(Metric.QUOTE_ANALYTICS_RECORDS_SENT)).toEqual([1]);
    expect(c.logger.atLevel('warn')).toHaveLength(1);
  });

  it('writes an oversized record as its log line without sending it', async () => {
    const writer = new FakeFirehoseBatchWriter();
    const analytics = new DirectQuoteAnalytics(SOFT_STREAMS, writer);
    const { lines, writeLogLine } = lineRecorder();
    const big = { blob: 'x'.repeat(FIREHOSE_MAX_RECORD_BYTES) };
    analytics.record('QuoteResponse', big, writeLogLine);
    analytics.record('QuoteResponse', { n: 1 }, writeLogLine);
    const c = ctx();
    await analytics.flush(c);
    expect(lines).toEqual([{ eventType: 'QuoteResponse', body: big }]);
    expect(writer.puts).toEqual([{ streamName: STREAMS.QuoteResponse, records: ['{"n":1}\n'] }]);
    expect(c.metrics.calls.find((m) => m.name === Metric.QUOTE_ANALYTICS_RECORDS_FALLBACK)?.opts).toEqual({
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

describe('isAmbiguousTimeout', () => {
  it('treats only post-connect timeouts as ambiguous', () => {
    expect(isAmbiguousTimeout(timeoutError('Connection timed out after 500 ms'))).toBe(true);
    expect(isAmbiguousTimeout(timeoutError('Socket timed out without establishing a connection within 300 ms'))).toBe(
      false
    );
    expect(isAmbiguousTimeout(new Error('Connection timed out after 500 ms'))).toBe(false);
    expect(isAmbiguousTimeout('TimeoutError')).toBe(false);
  });
});

describe('selectQuoteAnalytics', () => {
  const log = () => ({ info: jest.fn(), error: jest.fn() });
  const directEnv = (types: readonly QuoteAnalyticsEventType[]) => ({
    ...Object.fromEntries(types.map((t) => [QUOTE_ANALYTICS_STREAM_ENV[t], STREAMS[t]])),
  });

  it('keeps the log lines where no stream names are set (local stack, tests)', () => {
    const l = log();
    expect(selectQuoteAnalytics(l, SOFT_QUOTE_ANALYTICS_EVENT_TYPES, {})).toBe(LOG_LINE_QUOTE_ANALYTICS);
    expect(l.error).not.toHaveBeenCalled();
  });

  it('goes direct when every stream name is set', () => {
    const env = directEnv(SOFT_QUOTE_ANALYTICS_EVENT_TYPES);
    const writer = new FakeFirehoseBatchWriter();
    expect(selectQuoteAnalytics(log(), SOFT_QUOTE_ANALYTICS_EVENT_TYPES, env, () => writer)).toBeInstanceOf(
      DirectQuoteAnalytics
    );
  });

  it("routes only the Lambda's own record types to the named streams", async () => {
    const writer = new FakeFirehoseBatchWriter();
    const env = directEnv([...SOFT_QUOTE_ANALYTICS_EVENT_TYPES, ...HARD_QUOTE_ANALYTICS_EVENT_TYPES]);
    const analytics = selectQuoteAnalytics(log(), HARD_QUOTE_ANALYTICS_EVENT_TYPES, env, () => writer);
    for (const t of ['QuoteRequest', 'QuoteResponse', 'HardRequest', 'HardResponse'] as const) {
      analytics.record(t, { t }, () => undefined);
    }
    await analytics.flush(ctx());
    expect(writer.puts.map((p) => p.streamName)).toEqual([STREAMS.HardRequest, STREAMS.HardResponse]);
  });

  it('keeps the log lines, and says so, when only some stream names are set', () => {
    const l = log();
    const env = directEnv(['QuoteRequest']);
    expect(selectQuoteAnalytics(l, SOFT_QUOTE_ANALYTICS_EVENT_TYPES, env)).toBe(LOG_LINE_QUOTE_ANALYTICS);
    expect(l.error).toHaveBeenCalledWith(
      expect.objectContaining({ missing: [QUOTE_ANALYTICS_STREAM_ENV.QuoteResponse] }),
      expect.any(String)
    );
  });
});
