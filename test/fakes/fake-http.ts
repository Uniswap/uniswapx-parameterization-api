import { OrderServiceHttp } from '../../lib/providers/order/uniswapxService';
import { HttpRequestConfig, HttpResponse } from '../../lib/util/fetch-http';

export type HttpMethod = 'get' | 'post';

/** One scripted outcome: a response to resolve with, or an error to reject with. */
export type FakeHttpReply = { status?: number; data?: unknown } | Error;

export interface RecordedHttpCall {
  method: HttpMethod;
  url: string;
  body?: unknown;
  config?: HttpRequestConfig;
}

/**
 * Scripted stand-in for the HTTP client the order-service client uses. Queue replies per
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

  public get = async <T = unknown>(url: string, config?: HttpRequestConfig): Promise<HttpResponse<T>> =>
    this.answer<T>({ method: 'get', url, config });

  public post = async <T = unknown>(
    url: string,
    body?: unknown,
    config?: HttpRequestConfig
  ): Promise<HttpResponse<T>> => this.answer<T>({ method: 'post', url, body, config });

  // The scripted body stands in for whatever the caller expects the server to send.
  private async answer<T>(call: RecordedHttpCall): Promise<HttpResponse<T>> {
    this.calls.push(call);
    const next = this.queues[call.method].shift();
    if (next === undefined) {
      throw new Error(`FakeHttp: unexpected ${call.method.toUpperCase()} ${call.url}`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return { status: 200, data: undefined, ...next } as HttpResponse<T>;
  }
}
