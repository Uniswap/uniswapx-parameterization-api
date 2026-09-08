import { Logger } from '../../lib/observability';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogRecord {
  level: LogLevel;
  /** Bindings accumulated through child(), root first. */
  bindings: Record<string, unknown>;
  /** The fields object of a `(fields, msg)` call; `{}` for a bare `(msg)` call. */
  fields: Record<string, unknown>;
  msg: string | undefined;
  args: unknown[];
}

/**
 * In-memory Logger that records every line. Children share the root's `records` array, so a
 * test holding the root sees lines emitted through any child — the way one bunyan stream would.
 */
export class FakeLogger implements Logger {
  public readonly records: LogRecord[];

  constructor(public readonly bindings: Record<string, unknown> = {}, records: LogRecord[] = []) {
    this.records = records;
  }

  public trace = this.at('trace');
  public debug = this.at('debug');
  public info = this.at('info');
  public warn = this.at('warn');
  public error = this.at('error');
  public fatal = this.at('fatal');

  public child(bindings: Record<string, unknown>): FakeLogger {
    return new FakeLogger({ ...this.bindings, ...bindings }, this.records);
  }

  /** Records at `level`, in emission order. */
  public atLevel(level: LogLevel): LogRecord[] {
    return this.records.filter((r) => r.level === level);
  }

  public reset(): void {
    this.records.length = 0;
  }

  private at(level: LogLevel) {
    return (first: string | object, ...rest: unknown[]): void => {
      if (typeof first === 'string') {
        this.records.push({ level, bindings: this.bindings, fields: {}, msg: first, args: rest });
        return;
      }
      const [msg, ...args] = rest;
      const hasMsg = typeof msg === 'string';
      this.records.push({
        level,
        bindings: this.bindings,
        fields: first as Record<string, unknown>,
        msg: hasMsg ? msg : undefined,
        args: hasMsg ? args : rest,
      });
    };
  }
}
