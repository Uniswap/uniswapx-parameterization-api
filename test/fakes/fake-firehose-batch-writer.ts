import { FirehoseBatchWriter } from '../../lib/providers/analytics';

export type FakeBatchReply = boolean[] | Error | ((records: Uint8Array[]) => boolean[]);

/**
 * Records every PutRecordBatch as decoded strings and answers from a per-stream script. The
 * default reply accepts every record.
 */
export class FakeFirehoseBatchWriter implements FirehoseBatchWriter {
  public readonly puts: { streamName: string; records: string[] }[] = [];

  constructor(private readonly replies: Partial<Record<string, FakeBatchReply>> = {}) {}

  public async putRecordBatch(streamName: string, records: Uint8Array[]): Promise<boolean[]> {
    this.puts.push({ streamName, records: records.map((r) => Buffer.from(r).toString('utf8')) });
    const reply = this.replies[streamName];
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(records);
    return reply ?? records.map(() => false);
  }

  /** Every record sent to `streamName`, parsed back to objects. */
  public parsed(streamName: string): unknown[] {
    return this.puts.filter((p) => p.streamName === streamName).flatMap((p) => p.records.map((r) => JSON.parse(r)));
  }
}
