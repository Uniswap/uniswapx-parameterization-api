import { PassThrough } from 'stream';

import { FLUSH_TIMEOUT_MS, flushStdout, flushStream } from '../../lib/util/stdout';

describe('flushStream', () => {
  it('resolves only after everything written before it has been consumed', async () => {
    // A PassThrough with a tiny high-water mark models a pipe whose buffer is smaller than the
    // pending write: the big line sits partly unflushed until a reader drains it.
    const pipe = new PassThrough({ highWaterMark: 16 });
    const big = 'x'.repeat(64 * 1024);
    pipe.write(big);

    let flushed = false;
    const flushing = flushStream(pipe).then(() => {
      flushed = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(flushed).toBe(false); // nothing has read the pipe yet

    let consumed = 0;
    pipe.on('data', (chunk: Buffer) => {
      consumed += chunk.length;
    });
    await flushing;
    expect(flushed).toBe(true);
    expect(consumed).toBe(big.length);
  });

  it('resolves immediately when nothing is pending', async () => {
    const pipe = new PassThrough();
    pipe.resume();
    const started = Date.now();
    await flushStream(pipe);
    expect(Date.now() - started).toBeLessThan(FLUSH_TIMEOUT_MS);
  });

  it('flushStdout resolves against the real stdout', async () => {
    await expect(flushStdout()).resolves.toBeUndefined();
  });
});
