import { MetricOptions, Metrics } from '../../lib/observability';

export type MetricKind = 'count' | 'timer' | 'gauge';

export interface RecordedMetric {
  kind: MetricKind;
  name: string;
  value: number;
  opts: Partial<MetricOptions> | undefined;
}

/**
 * In-memory Metrics that records every call, for asserting on what a code path emitted. Records
 * synchronously inside the async methods, like the real sinks, so a `void`-ed call is visible
 * as soon as the caller continues.
 */
export class FakeMetrics implements Metrics {
  public readonly calls: RecordedMetric[] = [];

  public async count(name: string, val = 1, opts?: Partial<MetricOptions>): Promise<void> {
    this.calls.push({ kind: 'count', name, value: val, opts });
  }

  public async timer(name: string, val: number, opts?: Partial<MetricOptions>): Promise<void> {
    this.calls.push({ kind: 'timer', name, value: val, opts });
  }

  public async gauge(name: string, val: number, opts?: Partial<MetricOptions>): Promise<void> {
    this.calls.push({ kind: 'gauge', name, value: val, opts });
  }

  /** Number of calls, of any kind, that emitted `name`. */
  public emitted(name: string): number {
    return this.calls.filter((c) => c.name === name).length;
  }

  /** Values emitted under `name`, in emission order. */
  public values(name: string): number[] {
    return this.calls.filter((c) => c.name === name).map((c) => c.value);
  }

  /** Distinct metric names, in first-emission order. */
  public names(): string[] {
    return [...new Set(this.calls.map((c) => c.name))];
  }

  public reset(): void {
    this.calls.length = 0;
  }
}
