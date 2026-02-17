export interface HttpClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  used: number;
  resetsAt: string | null;
}

export interface PodscanErrorDetails {
  code: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}

export class PodscanError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor({ code, message, status, details }: PodscanErrorDetails) {
    super(message);
    this.name = 'PodscanError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;

  rateLimit: RateLimitInfo | null = null;

  constructor(options: HttpClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://podscan.fm/api/v1';
    this.timeout = options.timeout ?? 30_000;
  }

  async get<T>(path: string, params?: object): Promise<T> {
    const url = this.buildUrl(path, params as Record<string, unknown> | undefined);
    return this.request<T>(url, { method: 'GET' });
  }

  async post<T>(path: string, body?: object): Promise<T> {
    const url = this.buildUrl(path);
    return this.request<T>(url, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  private buildUrl(path: string, params?: Record<string, unknown>): string {
    const url = new URL(`${this.baseUrl}${path}`);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          const serialized =
            typeof value === 'object'
              ? JSON.stringify(value)
              : String(value as string | number | boolean);
          url.searchParams.set(key, serialized);
        }
      }
    }

    return url.toString();
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.timeout);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });

      this.parseRateLimitHeaders(response.headers);

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as Record<
          string,
          unknown
        > | null;
        throw new PodscanError({
          code: typeof errorBody?.code === 'string' ? errorBody.code : 'api_error',
          message:
            typeof errorBody?.message === 'string'
              ? errorBody.message
              : `HTTP ${String(response.status)}: ${response.statusText}`,
          status: response.status,
          details: errorBody?.details as Record<string, unknown> | undefined,
        });
      }

      return (await response.json()) as T;
    } catch (error: unknown) {
      if (error instanceof PodscanError) throw error;

      if (error instanceof Error && error.name === 'AbortError') {
        throw new PodscanError({
          code: 'timeout',
          message: `Request timed out after ${String(this.timeout)}ms`,
          status: 0,
        });
      }

      throw new PodscanError({
        code: 'network_error',
        message: error instanceof Error ? error.message : 'Unknown network error',
        status: 0,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private parseRateLimitHeaders(headers: Headers): void {
    const limit = headers.get('x-ratelimit-limit');
    const remaining = headers.get('x-ratelimit-remaining');
    const used = headers.get('x-ratelimit-used');
    const resetsAt = headers.get('x-ratelimit-reset');

    if (limit ?? remaining) {
      this.rateLimit = {
        limit: limit ? parseInt(limit, 10) : 0,
        remaining: remaining ? parseInt(remaining, 10) : 0,
        used: used ? parseInt(used, 10) : 0,
        resetsAt: resetsAt ?? null,
      };
    }
  }
}
