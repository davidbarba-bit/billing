export type LagoErrorBody = {
  status: number;
  error: string;
  code: string;
  error_details?: unknown;
};

export type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export class TestClient {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  async request<T extends Json = Json>(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: T }> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
      ...(init.headers ?? {}),
    };
    const res = await fetch(url, {
      method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    const body = text.length === 0 ? ({} as T) : (JSON.parse(text) as T);
    return { status: res.status, body };
  }

  get<T extends Json = Json>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T extends Json = Json>(path: string, body?: unknown) {
    return this.request<T>("POST", path, { body });
  }
  put<T extends Json = Json>(path: string, body?: unknown) {
    return this.request<T>("PUT", path, { body });
  }
  delete<T extends Json = Json>(path: string) {
    return this.request<T>("DELETE", path);
  }
}
