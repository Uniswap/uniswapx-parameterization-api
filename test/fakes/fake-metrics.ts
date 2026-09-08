import { Metrics, MetricTags } from '../../lib/observability';

export type MetricKind = 'increment' | 'gauge' | 'histogram';

export interface RecordedMetric {
  kind: MetricKind;
  name: string;
  value: number;
  tags: MetricTags | undefined;
}

/** In-memory Metrics that records every call, for asserting on what a code path emitted. */
export class FakeMetrics implements Metrics {
  public readonly calls: RecordedMetric[] = [];

  public increment(name: string, value = 1, tags?: MetricTags): void {
    this.calls.push({ kind: 'increment', name, value, tags });
  }

  public gauge(name: string, value: number, tags?: MetricTags): void {
    this.calls.push({ kind: 'gauge', name, value, tags });
  }

  public histogram(name: string, value: number, tags?: MetricTags): void {
    this.calls.push({ kind: 'histogram', name, value, tags });
  }

  /** Number of calls, of any kind, that emitted `name`. */
  public count(name: string): number {
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
