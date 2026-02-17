/**
 * Shared test utilities for mocking the global fetch.
 */

export interface MockFetchOptions {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  throwError?: Error;
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/**
 * Installs a mock `fetch` on globalThis and returns helpers to inspect
 * captured requests and restore the original.
 */
export function mockFetch(options: MockFetchOptions = {}) {
  const { status = 200, body = {}, headers = {}, throwError } = options;

  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const reqHeaders: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) {
        reqHeaders[k] = v;
      }
    }

    captured.push({
      url,
      method: init?.method ?? 'GET',
      headers: reqHeaders,
      body: (init?.body as string) ?? null,
    });

    if (throwError) {
      throw throwError;
    }

    const responseHeaders = new Headers(headers);

    return new Response(JSON.stringify(body), {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: responseHeaders,
    });
  }) as typeof fetch;

  return {
    captured,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

/**
 * Installs a mock fetch that sequences through multiple responses.
 */
export function mockFetchSequence(responses: MockFetchOptions[]) {
  let callIndex = 0;
  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const reqHeaders: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) {
        reqHeaders[k] = v;
      }
    }

    captured.push({
      url,
      method: init?.method ?? 'GET',
      headers: reqHeaders,
      body: (init?.body as string) ?? null,
    });

    const opts = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;

    if (opts.throwError) {
      throw opts.throwError;
    }

    const responseHeaders = new Headers(opts.headers ?? {});
    const status = opts.status ?? 200;

    return new Response(JSON.stringify(opts.body ?? {}), {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: responseHeaders,
    });
  }) as typeof fetch;

  return {
    captured,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}
