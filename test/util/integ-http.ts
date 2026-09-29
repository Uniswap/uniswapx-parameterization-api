import { expect } from 'chai';

// Integration tests call the deployed API through this. The API's WAF answers bursts with 429,
// so those are retried (twice, with exponential backoff) before a test sees them.
const RETRIES = 2;
const BASE_DELAY_MS = 100;
// Far below mocha's 120s test timeout, so a hung request fails its test instead of the run.
const REQUEST_TIMEOUT_MS = 30_000;

export interface IntegResponse {
  status: number;
  data: any;
}

export default class IntegHttp {
  /** Sends the request and returns the status and body, whatever the status. */
  static async callPassThroughFail(
    method: string,
    url: string,
    body: unknown,
    headers?: Record<string, string>
  ): Promise<IntegResponse> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(body !== undefined && body !== null && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      if (response.status === 429 && attempt < RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * 2 ** attempt * (1 + Math.random())));
        continue;
      }
      return { status: response.status, data: parse(text) };
    }
  }

  /** Sends the request and asserts it failed with a response containing `resp`. */
  static async callAndExpectFail(
    method: string,
    url: string,
    body: unknown,
    resp: { status: number; data: any },
    headers?: Record<string, string>
  ): Promise<void> {
    const response = await IntegHttp.callPassThroughFail(method, url, body, headers);
    expect(response.status, `expected ${method} ${url} to fail`).to.not.be.within(200, 299);
    expect(response).to.containSubset(resp);
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
