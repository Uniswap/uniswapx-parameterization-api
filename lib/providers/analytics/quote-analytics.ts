import { FirehoseClient, PutRecordBatchCommand } from '@aws-sdk/client-firehose';

import { Metric } from '../../entities/aws-metrics-logger';
import { Context } from '../../observability';
import { STAGE } from '../../util/stage';

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
 * The record types each Lambda writes to its streams. The hard-quote Lambda also produces
 * `QuoteResponse` records (the quoter's opposing-side responses); those were never loaded and stay
 * log lines.
 */
export const SOFT_QUOTE_ANALYTICS_EVENT_TYPES: readonly QuoteAnalyticsEventType[] = ['QuoteRequest', 'QuoteResponse'];
export const HARD_QUOTE_ANALYTICS_EVENT_TYPES: readonly QuoteAnalyticsEventType[] = ['HardRequest', 'HardResponse'];

/** Writes a record as a log line: the local stack's sink, and the form for record types no stream takes. */
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

/** Every record is its log line, written immediately. Used where no streams exist (local stack, tests). */
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
  /** Resolves with one entry per record: Firehose's `ErrorCode` where it refused that record. */
  putRecordBatch(streamName: string, records: Uint8Array[]): Promise<(string | undefined)[]>;
}

// The flush sits in series with the response, so a stalled put must not hold the request (puts
// from these Lambdas average ~8 ms). One attempt, no retry: a failed record is dropped and counted.
// Widen if QUOTE_ANALYTICS_RECORDS_DROPPED shows the request timeout is too tight.
export const QUOTE_ANALYTICS_FIREHOSE_CONNECTION_TIMEOUT_MS = 100;
export const QUOTE_ANALYTICS_FIREHOSE_REQUEST_TIMEOUT_MS = 250;
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
      return records.map((_, i) => responses[i]?.ErrorCode);
    },
  };
}

enum DropReason {
  REJECTED = 'rejected',
  REQUEST_FAILED = 'request_failed',
  TOO_LARGE = 'too_large',
}

interface PendingRecord {
  eventType: QuoteAnalyticsEventType;
  data: Uint8Array;
}

interface FlushTally {
  sent: number;
  dropped: Map<DropReason, number>;
}

/**
 * Sends each record as its own Firehose record, one flat JSON object per line (`JSON.stringify(body)`
 * plus a newline), into the quote analytics streams.
 *
 * Delivery is best-effort, as in the monorepo's ETLLogger: records Firehose refused, records in a
 * failed put, and oversized records are dropped and counted by reason, never re-sent, so a put that
 * did reach Firehose can't produce a duplicate row.
 */
export class DirectQuoteAnalytics implements QuoteAnalytics {
  private queue: PendingRecord[] = [];

  constructor(
    private readonly streams: Partial<Record<QuoteAnalyticsEventType, string>>,
    private readonly writer: FirehoseBatchWriter
  ) {}

  public record(eventType: QuoteAnalyticsEventType, body: object, writeLogLine: AnalyticsLogLine): void {
    // Not a record type this Lambda loads (see the EVENT_TYPES above): keep it a log line.
    if (!this.streams[eventType]) {
      writeLogLine({ eventType, body });
      return;
    }
    let data: Uint8Array;
    try {
      data = Buffer.from(JSON.stringify(body) + '\n');
    } catch {
      // A BigInt or a cycle: not loadable either way. bunyan's safe serializer still logs it.
      writeLogLine({ eventType, body });
      return;
    }
    this.queue.push({ eventType, data });
  }

  public async flush(ctx: Context): Promise<void> {
    const pending = this.queue;
    this.queue = [];
    if (pending.length === 0) return;

    const start = Date.now();
    const tally: FlushTally = { sent: 0, dropped: new Map() };
    const batches: { stream: string; records: PendingRecord[] }[] = [];
    for (const [stream, records] of groupByStream(pending, this.streams)) {
      const sendable: PendingRecord[] = [];
      for (const r of records) {
        if (r.data.byteLength > FIREHOSE_MAX_RECORD_BYTES) {
          drop(DropReason.TOO_LARGE, 1, tally);
        } else {
          sendable.push(r);
        }
      }
      for (const chunk of chunkForBatch(sendable)) batches.push({ stream, records: chunk });
    }
    await Promise.all(batches.map((b) => this.sendBatch(ctx, b.stream, b.records, tally)));

    void ctx.metrics.timer(Metric.QUOTE_ANALYTICS_FLUSH_LATENCY, Date.now() - start);
    if (tally.sent > 0) void ctx.metrics.count(Metric.QUOTE_ANALYTICS_RECORDS_SENT, tally.sent);
    for (const [reason, n] of tally.dropped) {
      void ctx.metrics.count(Metric.QUOTE_ANALYTICS_RECORDS_DROPPED, n, {
        tags: ['status:failure', `reason:${reason}`],
      });
    }
  }

  private async sendBatch(ctx: Context, stream: string, records: PendingRecord[], tally: FlushTally): Promise<void> {
    try {
      const errorCodes = await this.writer.putRecordBatch(
        stream,
        records.map((r) => r.data)
      );
      const refused = new Map<string, number>();
      errorCodes.forEach((code) => {
        if (code !== undefined) refused.set(code, (refused.get(code) ?? 0) + 1);
      });
      const refusedCount = [...refused.values()].reduce((x, y) => x + y, 0);
      tally.sent += records.length - refusedCount;
      if (refusedCount > 0) {
        drop(DropReason.REJECTED, refusedCount, tally);
        ctx.logger.warn('Quote analytics records refused; dropped', {
          stream,
          records: records.length,
          failedPutCount: refusedCount,
          errorCodes: Object.fromEntries(refused),
        });
      }
    } catch (e) {
      drop(DropReason.REQUEST_FAILED, records.length, tally);
      ctx.logger.warn('Quote analytics put failed; records dropped', {
        stream,
        records: records.length,
        error: errorMessage(e),
      });
    }
  }
}

function drop(reason: DropReason, n: number, tally: FlushTally): void {
  tally.dropped.set(reason, (tally.dropped.get(reason) ?? 0) + n);
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

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * The sink for this container. The API stack sets a stream name for every record type a quote
 * Lambda writes in every deployed stage. A deployed stage missing any of them is a deploy bug and
 * fails the container build, since records would otherwise be lost silently; the local stack has no
 * streams and logs its records. Logged once per container so the path in use is visible.
 */
export function selectQuoteAnalytics(
  log: { info(fields: object, msg: string): void },
  stage: STAGE,
  eventTypes: readonly QuoteAnalyticsEventType[],
  configuredStreams: Partial<Record<QuoteAnalyticsEventType, string>>,
  writer: () => FirehoseBatchWriter = firehoseBatchWriter
): QuoteAnalytics {
  const streams: Partial<Record<QuoteAnalyticsEventType, string>> = {};
  const missing: string[] = [];
  for (const eventType of eventTypes) {
    const name = configuredStreams[eventType];
    if (name) {
      streams[eventType] = name;
    } else {
      missing.push(QUOTE_ANALYTICS_STREAM_ENV[eventType]);
    }
  }
  if (stage === STAGE.LOCAL && missing.length === eventTypes.length) {
    log.info({ quoteAnalyticsSink: 'logs' }, 'Quote analytics sink');
    return LOG_LINE_QUOTE_ANALYTICS;
  }
  if (missing.length > 0) {
    throw new Error(`Quote analytics stream names not set: ${missing.join(', ')}`);
  }
  log.info({ quoteAnalyticsSink: 'direct', streams }, 'Quote analytics sink');
  return new DirectQuoteAnalytics(streams, writer());
}
