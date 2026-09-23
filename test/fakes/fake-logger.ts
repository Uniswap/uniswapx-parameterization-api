import { LogExtra, Logger } from '../../lib/observability';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogRecord {
  level: LogLevel;
  msg: string;
  /** The extras passed after the message, merged left to right; an Error lands under `err`. */
  fields: Record<string, unknown>;
  /** Bindings in force when the line was logged: the constructor's plus every setDefaultExtra. */
  bindings: Record<string, unknown>;
}

/**
 * In-memory Logger that records every line. Children share the root's `records` array, so a
 * test holding the root sees lines emitted through any child — the way one bunyan stream would.
 */
export class FakeLogger implements Logger {
  public readonly records: LogRecord[];
  public bindings: Record<string, unknown>;

  constructor(bindings: Record<string, unknown> = {}, records: LogRecord[] = []) {
    this.bindings = { ...bindings };
    this.records = records;
  }

  public debug(msg: string, ...extra: LogExtra[]): void {
    this.record('debug', msg, extra);
  }

  public info(msg: string, ...extra: LogExtra[]): void {
    this.record('info', msg, extra);
  }

  public warn(msg: string, ...extra: LogExtra[]): void {
    this.record('warn', msg, extra);
  }

  public error(msg: string, ...extra: LogExtra[]): void {
    this.record('error', msg, extra);
  }

  public fatal(msg: string, ...extra: LogExtra[]): void {
    this.record('fatal', msg, extra);
  }

  public child(): FakeLogger {
    return new FakeLogger(this.bindings, this.records);
  }

  public setDefaultExtra(...extra: LogExtra[]): void {
    this.bindings = { ...this.bindings, ...mergeExtra(extra) };
  }

  /** Records at `level`, in emission order. */
  public atLevel(level: LogLevel): LogRecord[] {
    return this.records.filter((r) => r.level === level);
  }

  public reset(): void {
    this.records.length = 0;
  }

  private record(level: LogLevel, msg: string, extra: LogExtra[]): void {
    this.records.push({ level, msg, fields: mergeExtra(extra), bindings: { ...this.bindings } });
  }
}

function mergeExtra(extra: LogExtra[]): Record<string, unknown> {
  return extra.reduce<Record<string, unknown>>(
    (fields, item) => Object.assign(fields, item instanceof Error ? { err: item } : item),
    {}
  );
}
