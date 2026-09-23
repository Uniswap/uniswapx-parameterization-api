/**
 * Per-call options, the monorepo's MetricOptions (backend `packages/lib/uni/interface.ts`):
 * `tags` are `key:value` strings and `dimensions` is the map form of the same. The monorepo
 * requires a `status:success|failure` tag on every operation and a `reason:<enum>` tag on
 * failures; call sites add those as they move onto ctx. The EMF adapter drops both (see
 * EmfMetrics); the StatsD sink applies them.
 */
export type MetricOptions = {
  sampleRate: number;
  tags: Array<string>;
  dimensions: Record<string, string>;
};

/**
 * The subset of the monorepo's IMetrics this service uses — same method names, signatures and
 * Promise<void> return — so an IMetrics is assignable to it and the port swaps the type, not
 * the call sites. Kinds follow the monorepo's rule: `count` for occurrences, `timer` for
 * durations only, `gauge` for levels. Under EMF they are the units the handlers have always
 * emitted: count -> Count, timer -> Milliseconds, gauge -> None.
 *
 * Call-site discipline (the monorepo lints it with no-floating-promises): `await` in the main
 * flow, `void` inside catch/finally so a sink failure can never change the outcome.
 */
export interface Metrics {
  count(name: string, val?: number, opts?: Partial<MetricOptions>): Promise<void>;
  timer(name: string, val: number, opts?: Partial<MetricOptions>): Promise<void>;
  gauge(name: string, val: number, opts?: Partial<MetricOptions>): Promise<void>;
}
