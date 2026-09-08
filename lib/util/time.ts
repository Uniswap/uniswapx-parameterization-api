export const currentTimestampInMs = () => Date.now().toString();
export const timestampInMstoISOString = (timestamp: number) => new Date(timestamp).toISOString();
export const timestampInMstoSeconds = (timestamp: number) => Math.floor(timestamp / 1000).toString();

export function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Settles with `promise`, or rejects with "<label> timed out after <ms>ms" once `ms` has
 * elapsed. Promise.race keeps subscribing to the loser, so a promise that rejects after the
 * timeout fired is swallowed rather than surfacing as an unhandled rejection; the timer is
 * always cleared so a fast promise leaves nothing pending on the event loop. The loser is not
 * cancelled: a caller that needs the underlying call to stop must pass its own AbortSignal.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
