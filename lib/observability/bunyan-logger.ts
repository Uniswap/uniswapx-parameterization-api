import { default as Bunyan } from 'bunyan';

import { LogExtra, Logger } from './logger';

/**
 * Logger over a bunyan logger: flips the message-first `(msg, ...extra)` the interface takes
 * into bunyan's fields-first `(fields, msg)`. Extras merge left to right; an Error goes under
 * `err`, where bunyan's standard serializers render it (the monorepo's pino logger does the same
 * with `{ err: { message, stack } }`). The record bunyan writes is unchanged — the wrapped
 * logger's bindings, the fields, then `msg` — and an empty message serializes as `"msg":""`,
 * exactly what bunyan writes for a fields-only call.
 */
export class BunyanLogger implements Logger {
  constructor(private bunyan: Bunyan) {}

  public debug(msg: string, ...extra: LogExtra[]): void {
    this.bunyan.debug(mergeExtra(extra), msg);
  }

  public info(msg: string, ...extra: LogExtra[]): void {
    this.bunyan.info(mergeExtra(extra), msg);
  }

  public warn(msg: string, ...extra: LogExtra[]): void {
    this.bunyan.warn(mergeExtra(extra), msg);
  }

  public error(msg: string, ...extra: LogExtra[]): void {
    this.bunyan.error(mergeExtra(extra), msg);
  }

  public fatal(msg: string, ...extra: LogExtra[]): void {
    this.bunyan.fatal(mergeExtra(extra), msg);
  }

  public child(): Logger {
    return new BunyanLogger(this.bunyan.child({}));
  }

  /** Binds by swapping in a bunyan child, so the wrapped logger — still shared with the quote path — is untouched. */
  public setDefaultExtra(...extra: LogExtra[]): void {
    this.bunyan = this.bunyan.child(mergeExtra(extra));
  }
}

/** Left-to-right merge of the extras; an Error lands under `err`, which a later map may override. */
function mergeExtra(extra: LogExtra[]): Record<string, unknown> {
  return extra.reduce<Record<string, unknown>>(
    (fields, item) => Object.assign(fields, item instanceof Error ? { err: item } : item),
    {}
  );
}
