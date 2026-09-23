import { AxiosRequestConfig, AxiosResponse } from 'axios';

import { OrderServiceHttp } from '../../lib/providers/order/uniswapxService';

export type HttpMethod = 'get' | 'post';

/** One scripted outcome: a response to resolve with, or an error to reject with. */
export type FakeHttpReply = { status?: number; data?: unknown } | Error;

export interface RecordedHttpCall {
  method: HttpMethod;
  url: string;
  body?: unknown;
  config?: AxiosRequestConfig;
}

/**
 * Scripted stand-in for the axios subset the order-service client uses. Queue replies per
 * method with `reply`, then assert on `calls`. A call with nothing queued fails loudly, so a
 * test can't silently exercise a request it didn't expect.
 */
export class FakeHttp implements OrderServiceHttp {
  public readonly calls: RecordedHttpCall[] = [];
  private readonly queues: Record<HttpMethod, FakeHttpReply[]> = { get: [], post: [] };

  public reply(method: HttpMethod, ...replies: FakeHttpReply[]): this {
    this.queues[method].push(...replies);
    return this;
  }

  public callsTo(method: HttpMethod): RecordedHttpCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  public get = async <T = unknown, R = AxiosResponse<T>>(url: string, config?: AxiosRequestConfig): Promise<R> =>
    this.answer<R>({ method: 'get', url, config });

  public post = async <T = unknown, R = AxiosResponse<T>>(
    url: string,
    body?: unknown,
    config?: AxiosRequestConfig
  ): Promise<R> => this.answer<R>({ method: 'post', url, body, config });

  private async answer<R>(call: RecordedHttpCall): Promise<R> {
    this.calls.push(call);
    const next = this.queues[call.method].shift();
    if (next === undefined) {
      throw new Error(`FakeHttp: unexpected ${call.method.toUpperCase()} ${call.url}`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return { status: 200, data: undefined, ...next } as unknown as R;
  }
}
