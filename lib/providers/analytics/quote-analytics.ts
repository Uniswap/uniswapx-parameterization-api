import { FirehoseClient, PutRecordBatchCommand } from '@aws-sdk/client-firehose';

import { Metric } from '../../entities/aws-metrics-logger';
import { Context } from '../../observability';

/** The four quote record types. Each is one BigQuery table downstream. */
export type QuoteAnalyticsEventType = 'QuoteRequest' | 'QuoteResponse' | 'HardRequest' | 'HardResponse';

/** Env vars carrying each record type's direct-write stream name, set by the API stack. */
export const QUOTE_ANALYTICS_STREAM_ENV: Record<QuoteAnalyticsEventType, string> = {
  QuoteRequest: 'QUOTE_ANALYTICS_RFQ_REQUEST_STREAM',
  QuoteResponse: 'QUOTE_ANALYTICS_RFQ_RESPONSE_STREAM',
  HardRequest: 'QUOTE_ANALYTICS_HARD_REQUEST_STREAM',
  HardResponse: 'QUOTE_ANALYTICS_HARD_RESPONSE_STREAM',
};

/**
 * The record types each Lambda's subscription filters carry today (bin/stacks/analytics-stack.ts).
 * The direct sink routes exactly these, so it writes the same rows: the hard-quote Lambda also logs
 * `QuoteResponse` lines (the quoter's opposing-side responses), but no filter on its log group ever
 * forwarded them.
 */
export const SOFT_QUOTE_ANALYTICS_EVENT_TYPES: readonly QuoteAnalyticsEventType[] = ['QuoteRequest', 'QuoteResponse'];
export const HARD_QUOTE_ANALYTICS_EVENT_TYPES: readonly QuoteAnalyticsEventType[] = ['HardRequest', 'HardResponse'];

/** Writes today's analytics log line. The log-driven path's subscription filters match on `eventType`. */
export type AnalyticsLogLine = (fields: { eventType: QuoteAnalyticsEventType; body: object }) => void;

/**
 * Where a quote flow sends its analytics records. `record` never throws and never waits; `flush`
 * sends whatever is queued and never throws. On Lambda the handler must await `flush` before it
 * returns, or queued puts are frozen with the environment.
 */
export interface QuoteAnalytics {
  record(eventType: QuoteAnalyticsEventType, body: object, writeLogLine: AnalyticsLogLine): void;
  flush(ctx: Context): Promise<void>;
}

/** Every record is its log line, written immediately. Used where no direct-write streams exist. */
export class LogLineQuoteAnalytics implements QuoteAnalytics {
  public record(eventType: QuoteAnalyticsEventType, body: object, writeLogLine: AnalyticsLogLine): void {
    writeLogLine({ eventType, body });
  }

  public async flush(): Promise<void> {
    // Nothing is queued.
  }
}

export const LOG_LINE_QUOTE_ANALYTICS: QuoteAnalytics = new LogLineQuoteAnalytics();

/** What the direct sink needs from Firehose: one batch put, reporting which records were refused. */
export interface FirehoseBatchWriter {
  /** Resolves with one flag per record, `true` where Firehose refused that record. */
  putRecordBatch(streamName: string, records: Uint8Array[]): Promise<boolean[]>;
}

// The flush sits in series with the response, so a stalled put must not hold the request. One
// attempt: a refused batch falls back to the log line, which is the retry.
export const QUOTE_ANALYTICS_FIREHOSE_CONNECTION_TIMEOUT_MS = 300;
export const QUOTE_ANALYTICS_FIREHOSE_REQUEST_TIMEOUT_MS = 500;
export const QUOTE_ANALYTICS_FIREHOSE_MAX_ATTEMPTS = 1;

// PutRecordBatch limits.
export const FIREHOSE_MAX_BATCH_RECORDS = 500;
export const FIREHOSE_MAX_BATCH_BYTES = 4 * 1024 * 1024;
export const FIREHOSE_MAX_RECORD_BYTES = 1000 * 1024;

export function firehoseBatchWriter(): FirehoseBatchWriter {
  const client = new FirehoseClient({
    requestHandler: {
      connectionTimeout: QUOTE_ANALYTICS_FIREHOSE_CONNECTION_TIMEOUT_MS,
      requestTimeout: QUOTE_ANALYTICS_FIREHOSE_REQUEST_TIMEOUT_MS,
    },
    maxAttempts: QUOTE_ANALYTICS_FIREHOSE_MAX_ATTEMPTS,
  });
  return {
    async putRecordBatch(streamName, records) {
      const res = await client.send(
        new PutRecordBatchCommand({ DeliveryStreamName: streamName, Records: records.map((Data) => ({ Data })) })
      );
      const responses = res.RequestResponses ?? [];
      return records.map((_, i) => responses[i]?.ErrorCode !== undefined);
    },
  };
}

enum FallbackReason {
  REJECTED = 'rejected',
  REQUEST_FAILED = 'request_failed',
  TOO_LARGE = 'too_large',
}

interface PendingRecord {
  eventType: QuoteAnalyticsEventType;
  body: object;
  writeLogLine: AnalyticsLogLine;
  data: Uint8Array;
}

interface FlushTally {
  sent: number;
  fellBack: Map<FallbackReason, number>;
  dropped: number;
}

/**
 * Sends each record as its own Firehose record, one flat JSON object per line, into the
 * direct-write streams. The bytes match what the log-driven path's transform Lambda produces for
 * the same record (`JSON.stringify(body)`), plus the trailing newline that path omits (records
 * glued at its batch boundaries).
 *
 * Failure handling keeps the table free of duplicates:
 * - Refused records, a request that failed before reaching Firehose, and oversized records are
 *   written as their log line instead. The subscription filters still exist, so that line reaches
 *   the same bucket.
 * - A timeout after the connection opened is ambiguous (Firehose may hold the records), so those
 *   records are dropped and counted, never re-sent.
 */
export class DirectQuoteAnalytics implements QuoteAnalytics {
  private queue: PendingRecord[] = [];

  constructor(
    private readonly streams: Partial<Record<QuoteAnalyticsEventType, string>>,
    private readonly writer: FirehoseBatchWriter
  ) {}

  public record(eventType: QuoteAnalyticsEventType, body: object, writeLogLine: AnalyticsLogLine): void {
    // Not a record type this Lambda's subscription filters carry today (see the EVENT_TYPES above).
    if (!this.streams[eventType]) return;
    this.queue.push({ eventType, body, writeLogLine, data: Buffer.from(JSON.stringify(body) + '\n') });
  }

  public async flush(ctx: Context): Promise<void> {
    const pending = this.queue;
    this.queue = [];
    if (pending.length === 0) return;

    const start = Date.now();
    const tally: FlushTally = { sent: 0, fellBack: new Map(), dropped: 0 };
    const batches: { stream: string; records: PendingRecord[] }[] = [];
    for (const [stream, records] of groupByStream(pending, this.streams)) {
      const sendable: PendingRecord[] = [];
      for (const r of records) {
        if (r.data.byteLength > FIREHOSE_MAX_RECORD_BYTES) {
          fallBack(r, FallbackReason.TOO_LARGE, tally);
        } else {
          sendable.push(r);
        }
      }
      for (const chunk of chunkForBatch(sendable)) batches.push({ stream, records: chunk });
    }
    await Promise.all(batches.map((b) => this.sendBatch(ctx, b.stream, b.records, tally)));

    void ctx.metrics.timer(Metric.QUOTE_ANALYTICS_FLUSH_LATENCY, Date.now() - start);
    if (tally.sent > 0) void ctx.metrics.count(Metric.QUOTE_ANALYTICS_RECORDS_SENT, tally.sent);
    for (const [reason, n] of tally.fellBack) {
      void ctx.metrics.count(Metric.QUOTE_ANALYTICS_RECORDS_FALLBACK, n, {
        tags: ['status:failure', `reason:${reason}`],
      });
    }
    if (tally.dropped > 0) {
      void ctx.metrics.count(Metric.QUOTE_ANALYTICS_RECORDS_DROPPED, tally.dropped, {
        tags: ['status:failure', 'reason:timeout'],
      });
    }
  }

  private async sendBatch(ctx: Context, stream: string, records: PendingRecord[], tally: FlushTally): Promise<void> {
    try {
      const refused = await this.writer.putRecordBatch(
        stream,
        records.map((r) => r.data)
      );
      records.forEach((r, i) => {
        if (refused[i]) {
          fallBack(r, FallbackReason.REJECTED, tally);
        } else {
          tally.sent += 1;
        }
      });
    } catch (e) {
      if (isAmbiguousTimeout(e)) {
        tally.dropped += records.length;
        ctx.logger.warn('Quote analytics put timed out; records dropped', {
          stream,
          records: records.length,
          error: errorMessage(e),
        });
      } else {
        ctx.logger.warn('Quote analytics put failed; records written as log lines', {
          stream,
          records: records.length,
          error: errorMessage(e),
        });
        records.forEach((r) => fallBack(r, FallbackReason.REQUEST_FAILED, tally));
      }
    }
  }
}

function fallBack(r: PendingRecord, reason: FallbackReason, tally: FlushTally): void {
  r.writeLogLine({ eventType: r.eventType, body: r.body });
  tally.fellBack.set(reason, (tally.fellBack.get(reason) ?? 0) + 1);
}

function groupByStream(
  records: PendingRecord[],
  streams: Partial<Record<QuoteAnalyticsEventType, string>>
): Map<string, PendingRecord[]> {
  const byStream = new Map<string, PendingRecord[]>();
  for (const r of records) {
    const stream = streams[r.eventType];
    if (!stream) continue;
    const list = byStream.get(stream) ?? [];
    list.push(r);
    byStream.set(stream, list);
  }
  return byStream;
}

/** Splits records into PutRecordBatch-sized chunks (record count and total bytes). */
export function chunkForBatch<T extends { data: Uint8Array }>(records: T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const r of records) {
    if (
      current.length > 0 &&
      (current.length >= FIREHOSE_MAX_BATCH_RECORDS || bytes + r.data.byteLength > FIREHOSE_MAX_BATCH_BYTES)
    ) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(r);
    bytes += r.data.byteLength;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * True when a put may have reached Firehose. The SDK's HTTP handler names every timeout
 * `TimeoutError`; only the connection timeout ("without establishing a connection") proves nothing
 * was sent. Resets and request timeouts after connecting are ambiguous.
 */
export function isAmbiguousTimeout(e: unknown): boolean {
  if (!(e instanceof Error) || e.name !== 'TimeoutError') return false;
  return !e.message.includes('without establishing a connection');
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * The sink for this container. The API stack sets a stream name for every record type a quote
 * Lambda writes wherever the direct-write streams exist; with none (local stack, tests) records stay
 * log lines. A partial set is a deploy bug, and also keeps log lines rather than dropping rows.
 * Logged once per container so the path in use is visible.
 */
export function selectQuoteAnalytics(
  log: { info(fields: object, msg: string): void; error(fields: object, msg: string): void },
  eventTypes: readonly QuoteAnalyticsEventType[],
  env: NodeJS.ProcessEnv = process.env,
  writer: () => FirehoseBatchWriter = firehoseBatchWriter
): QuoteAnalytics {
  const streams: Partial<Record<QuoteAnalyticsEventType, string>> = {};
  const missing: string[] = [];
  for (const eventType of eventTypes) {
    const name = env[QUOTE_ANALYTICS_STREAM_ENV[eventType]];
    if (name) {
      streams[eventType] = name;
    } else {
      missing.push(QUOTE_ANALYTICS_STREAM_ENV[eventType]);
    }
  }
  if (missing.length === eventTypes.length) {
    log.info({ quoteAnalyticsSink: 'logs' }, 'Quote analytics sink');
    return LOG_LINE_QUOTE_ANALYTICS;
  }
  if (missing.length > 0) {
    log.error(
      { quoteAnalyticsSink: 'logs', missing },
      'Quote analytics sink: some stream names missing; using log lines'
    );
    return LOG_LINE_QUOTE_ANALYTICS;
  }
  log.info({ quoteAnalyticsSink: 'direct', streams }, 'Quote analytics sink');
  return new DirectQuoteAnalytics(streams, writer());
}
