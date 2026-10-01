import { FirehoseBatchWriter } from '../../lib/providers/analytics';

/** Per-record Firehose `ErrorCode`s (undefined = accepted), a thrown error, or a function of the records. */
export type FakeBatchReply = (string | undefined)[] | Error | ((records: Uint8Array[]) => (string | undefined)[]);

/**
 * Records every PutRecordBatch as decoded strings and answers from a per-stream script. The
 * default reply accepts every record.
 */
export class FakeFirehoseBatchWriter implements FirehoseBatchWriter {
  public readonly puts: { streamName: string; records: string[] }[] = [];

  constructor(private readonly replies: Partial<Record<string, FakeBatchReply>> = {}) {}

  public async putRecordBatch(streamName: string, records: Uint8Array[]): Promise<(string | undefined)[]> {
    this.puts.push({ streamName, records: records.map((r) => Buffer.from(r).toString('utf8')) });
    const reply = this.replies[streamName];
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(records);
    return reply ?? records.map(() => undefined);
  }

  /** Every record sent to `streamName`, parsed back to objects. */
  public parsed(streamName: string): unknown[] {
    return this.puts.filter((p) => p.streamName === streamName).flatMap((p) => p.records.map((r) => JSON.parse(r)));
  }
}
