/** What a log call may carry after the message: an Error, or a map of fields. */
export type LogExtra = Error | Record<string, unknown>;

/**
 * The subset of the monorepo's ILogger (backend `packages/lib/uni/interface.ts`) this service
 * uses, with the same method shapes: message first, then any number of field maps or Errors;
 * `child()` for a per-request copy; `setDefaultExtra` for the fields it binds. An ILogger is
 * assignable to this type, so the port swaps the type, not the call sites. bunyan is fields-first
 * and does not satisfy it structurally — BunyanLogger adapts it.
 */
export interface Logger {
  debug(msg: string, ...extra: LogExtra[]): void;
  info(msg: string, ...extra: LogExtra[]): void;
  warn(msg: string, ...extra: LogExtra[]): void;
  error(msg: string, ...extra: LogExtra[]): void;
  fatal(msg: string, ...extra: LogExtra[]): void;
  /** A logger carrying this logger's bindings, whose own setDefaultExtra does not leak back. */
  child(): Logger;
  /** Binds fields onto every later line from this logger. Repeated calls accumulate. */
  setDefaultExtra(...extra: LogExtra[]): void;
}
