/** Which way a webhook call left the service: straight to the market maker, or through the egress proxy. */
export type WebhookRoute = 'direct' | 'proxy';

export interface FetchConfig {
  timeoutMs?: number;
  /**
   * A fetch that chooses a path per call (see `splitFetch`) reports it here before sending, so
   * the caller can attribute the outcome to the path. A fetch with a single fixed path leaves it
   * uncalled, and the monorepo's `ctx.fetch` ignores it.
   */
  onRoute?: (route: WebhookRoute) => void;
}

/**
 * The outbound fetch every caller takes: the monorepo's `ctx.fetch` shape, with the timeout as a
 * third argument, so the port can hand in `ctx.fetch` unchanged.
 */
export type FetchFn = (input: string, init?: RequestInit, config?: FetchConfig) => Promise<Response>;

/**
 * The global fetch with `timeoutMs` as a wall-clock deadline over the whole request. The abort
 * also cancels a body still arriving, so a server that trickles its reply can't outlast it.
 * (The monorepo's `ctx.fetch` timeout bounds response headers only; the port should keep a
 * whole-request signal alongside it.)
 */
export const timedFetch: FetchFn = (input, init, config) =>
  config?.timeoutMs
    ? fetchUnderDeadline(config.timeoutMs, (signal) => fetch(input, { ...init, signal }))
    : fetch(input, init);

/**
 * Runs one fetch under a whole-request deadline whose timer keeps the event loop alive.
 *
 * `AbortSignal.timeout()` is the obvious tool, but its timer is unref'd. If the request it guards
 * ends up with no live handle of its own (seen in prod at roughly 1 in 500 webhook timeouts), the
 * event loop drains before the deadline fires; inside Lambda the Node runtime then treats the
 * invocation as finished and posts a null response, which API Gateway reports as a 502
 * "Malformed Lambda proxy response" with no Lambda error or log line. A ref'd timer holds the
 * loop open until the abort fires. (The abort alone turned out not to settle every request: see
 * `Deadline` in `fetchJson`, which gives up on such a promise a grace period later.)
 *
 * Once the response headers are in, the timer is unref'd rather than cleared: it still bounds the
 * body read (the abort cancels a body still arriving), but no longer holds the process open by
 * itself. The abort reason carries the same name and message as `AbortSignal.timeout()`'s, so
 * callers classify it the same way.
 */
export async function fetchUnderDeadline(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<Response>
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
  try {
    const response = await run(controller.signal);
    timer.unref();
    return response;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

/**
 * A request that didn't produce a 2xx: the server answered with another status (`status` and the
 * parsed body in `data`), the deadline passed, or the connection failed. Only `status` failures
 * mean the server saw and refused the request.
 */
export class HttpError extends Error {
  override readonly name = 'HttpError';

  constructor(
    message: string,
    readonly kind: 'status' | 'timeout' | 'network',
    readonly status?: number,
    readonly data?: unknown,
    /** The path the failed request took, when the fetch reported one. */
    readonly route?: WebhookRoute,
    /**
     * Set when the request's promise had still not settled a grace period after its deadline and
     * fetchJson answered without it: which step was pending. Such an error is also a `timeout`.
     */
    readonly unsettled?: RequestPhase
  ) {
    super(message);
  }
}

/** The step of a request a deadline can catch still pending. */
export type RequestPhase = 'headers' | 'body';

/** How a request fetchJson had already given up on eventually ended. */
export interface LateSettlement {
  phase: RequestPhase;
  outcome: 'resolved' | 'rejected';
  /** Milliseconds after fetchJson gave up on the promise. */
  afterMs: number;
  error?: unknown;
}

export interface JsonRequest {
  method: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Receives the path the fetch reports for this request, if it reports one. */
  onRoute?: (route: WebhookRoute) => void;
  /** Called if a request fetchJson gave up on (`HttpError.unsettled`) settles later, or never called. */
  onLateSettle?: (settlement: LateSettlement) => void;
}

/**
 * How long past `timeoutMs` fetchJson waits for the fetch's own abort to settle the request
 * before giving up on the promise. The abort settles it in the same tick when it works at all,
 * so this only needs to cover timer ordering.
 */
const UNSETTLED_GRACE_MS = 25;

/** The reason `AbortSignal.timeout()` aborts with, so callers classify our deadlines the same way. */
function timeoutError(): Error {
  return Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
}

/**
 * A ref'd timer that rejects whatever `race` is waiting on when it fires, so a request settles
 * at its deadline even if the fetch's own abort fails to settle it.
 *
 * In prod the abort did not settle roughly 1 in 350 timed-out requests to one endpoint: the
 * promise stayed pending after the abort with no socket left to keep the event loop alive, the
 * loop drained mid-invocation, and the Lambda answered with nothing. Racing the promise against
 * this timer makes the outcome independent of the fetch's internals; the abandoned promise is
 * left to settle whenever it does, and `onLateSettle` reports if and when, which is the evidence
 * needed to find the underlying cause.
 */
class Deadline {
  /** Which step the deadline caught still pending, once it has fired on one. */
  public unsettled?: RequestPhase;
  private readonly timer: NodeJS.Timeout;
  private pending?: { phase: RequestPhase; promise: Promise<unknown>; reject: (e: unknown) => void };

  constructor(ms: number, private readonly onLateSettle?: (settlement: LateSettlement) => void) {
    this.timer = setTimeout(() => this.fire(), ms);
  }

  /** Resolves or rejects with `promise`, or rejects with a TimeoutError if the deadline fires first. */
  public race<T>(phase: RequestPhase, promise: Promise<T>): Promise<T> {
    if (this.unsettled) {
      return Promise.reject(timeoutError());
    }
    return new Promise<T>((resolve, reject) => {
      this.pending = { phase, promise, reject };
      const settle =
        <R>(handler: (value: R) => void) =>
        (value: R) => {
          this.pending = undefined;
          handler(value);
        };
      promise.then(settle(resolve), settle(reject));
    });
  }

  public clear(): void {
    clearTimeout(this.timer);
  }

  private fire(): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.pending = undefined;
    this.unsettled = pending.phase;
    pending.reject(timeoutError());
    const gaveUpAt = Date.now();
    // The report runs in whatever invocation is current when the promise settles; a throwing
    // callback must not become an unhandled rejection there.
    const report = (outcome: LateSettlement['outcome'], error?: unknown) => {
      try {
        this.onLateSettle?.({ phase: pending.phase, outcome, afterMs: Date.now() - gaveUpAt, error });
      } catch {
        // nothing to do
      }
    };
    pending.promise.then(
      (value) => {
        // A Response nobody will read would hold its pooled connection until the peer closes it.
        if (value instanceof Response) {
          void value.body?.cancel().catch(() => undefined);
        }
        report('resolved');
      },
      (error) => report('rejected', error)
    );
  }
}

/**
 * The message worth logging for a failed request, and the socket-level code when there is one:
 * fetch wraps the cause (`ECONNRESET`, `UND_ERR_SOCKET`, ...) in `TypeError: fetch failed`.
 */
export function errorDetail(e: unknown): { message: string; code?: string } {
  const cause = typeof e === 'object' && e !== null && 'cause' in e && e.cause ? e.cause : e;
  const code = field(cause, 'code');
  return { message: networkMessage(e), ...(code !== undefined && { code }) };
}

/**
 * Sends a request with a JSON body (when there is one) and reads the reply, JSON-parsed when it
 * parses and text when it doesn't (`''` when empty). A 2xx resolves; anything else throws an
 * HttpError. The messages are the ones the analytics records and logs have always carried.
 */
export async function fetchJson<T>(
  fetchFn: FetchFn,
  url: string,
  { method, body, headers, timeoutMs, onRoute, onLateSettle }: JsonRequest
): Promise<{ status: number; data: T; route?: WebhookRoute }> {
  // Per-endpoint headers replace a default of the same name, whatever its case.
  const requestHeaders = new Headers({
    Accept: 'application/json, text/plain, */*',
    ...(body !== undefined && { 'Content-Type': 'application/json' }),
  });
  for (const [name, value] of Object.entries(headers ?? {})) {
    requestHeaders.set(name, value);
  }

  // The route is kept for the result and for the HttpError, so a failure can be attributed to
  // the path even though the fetch itself only reports the route before sending.
  let route: WebhookRoute | undefined;
  const noteRoute = (r: WebhookRoute) => {
    route = r;
    onRoute?.(r);
  };

  // The fetch bounds itself with `timeoutMs` (see fetchUnderDeadline); this deadline is the
  // fallback for a promise that abort leaves unsettled, so the caller always gets an answer.
  const deadline = timeoutMs ? new Deadline(timeoutMs + UNSETTLED_GRACE_MS, onLateSettle) : undefined;
  let response: Response;
  let text: string;
  try {
    const sent = fetchFn(
      url,
      { method, headers: requestHeaders, ...(body !== undefined && { body: JSON.stringify(body) }) },
      { timeoutMs, onRoute: noteRoute }
    );
    response = await (deadline ? deadline.race('headers', sent) : sent);
    // Read under the same deadline: the abort also cancels a body still arriving.
    const read = response.text();
    text = await (deadline ? deadline.race('body', read) : read);
  } catch (e) {
    throw isTimeout(e)
      ? new HttpError(
          timeoutMs ? `timeout of ${timeoutMs}ms exceeded` : 'timeout exceeded',
          'timeout',
          undefined,
          undefined,
          route,
          deadline?.unsettled
        )
      : new HttpError(networkMessage(e), 'network', undefined, undefined, route);
  } finally {
    deadline?.clear();
  }

  const data = parseBody(text);
  if (!response.ok) {
    throw new HttpError(`Request failed with status code ${response.status}`, 'status', response.status, data, route);
  }
  // The body's type is the caller's claim about the server; it is not validated here.
  return { status: response.status, data: data as T, route };
}

function parseBody(text: string): unknown {
  if (text === '') {
    return '';
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// By name, not instanceof: the abort is a DOMException, which isn't an Error subclass in every
// runtime, and the monorepo's ErrTimeout may come from another bundle's copy of the class.
function isTimeout(e: unknown): boolean {
  const name = field(e, 'name');
  return name === 'TimeoutError' || name === 'AbortError' || name === 'ErrTimeout';
}

// fetch reports a network failure as `TypeError: fetch failed` with the socket error as the cause;
// the cause's message (e.g. `connect ECONNREFUSED 10.0.0.1:443`) is the useful part.
function networkMessage(e: unknown): string {
  const cause = typeof e === 'object' && e !== null && 'cause' in e && e.cause ? e.cause : e;
  return field(cause, 'message') ?? String(cause);
}

// Duck-typed: errors thrown by Node's own fetch fail `instanceof Error` under jest's realm.
function field(e: unknown, name: 'name' | 'message' | 'code'): string | undefined {
  if (typeof e !== 'object' || e === null || !(name in e)) {
    return undefined;
  }
  const value = (e as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}
