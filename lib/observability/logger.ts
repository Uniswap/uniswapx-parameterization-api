/**
 * The two call shapes bunyan and pino share: a message with format args, or a fields object
 * with an optional message. Bunyan's overload set is a superset of this, so the bunyan logger
 * the injector builds satisfies the type structurally, with no adapter.
 */
export interface LogFn {
  (msg: string, ...args: unknown[]): void;
  (fields: object, msg?: string, ...args: unknown[]): void;
}

/**
 * The logging surface the request path is allowed to depend on: the level methods and
 * `child`, i.e. the intersection of bunyan and pino. Everything else on the concrete logger
 * (level(), streams, serializers) belongs to the injector that creates it.
 */
export interface Logger {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  /** A logger that adds `bindings` to every line it, and its own children, emit. */
  child(bindings: Record<string, unknown>): Logger;
}
