import { Writable } from 'stream';

// Upper bound on waiting for the stream to drain. The Lambda runtime always reads its side of
// the pipe, so this never fires in practice; it only guarantees a flush can't hang a run.
export const FLUSH_TIMEOUT_MS = 2_000;

/**
 * Resolves once everything already written to `stream` has been handed to the OS (or after
 * FLUSH_TIMEOUT_MS). In Lambda, process.stdout is a pipe, and Node writes to pipes
 * asynchronously: a large log line written just before the handler returns is cut at the pipe
 * buffer (64 KiB) and every later line is lost when the runtime freezes the process. Awaiting
 * this before returning lets the runtime's log reader drain the pipe first.
 */
export function flushStream(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
    // An empty write is queued behind everything pending; its callback fires once all of it
    // has been flushed (or the stream errored, which we treat the same — nothing more to wait for).
    stream.write('', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export const flushStdout = (): Promise<void> => flushStream(process.stdout);
