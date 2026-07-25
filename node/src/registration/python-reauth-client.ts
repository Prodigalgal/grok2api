export interface PythonReauthClientOptions {
  readonly serviceUrl: string;
  readonly token: string | null;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
  readonly readinessRetryMs?: number;
}

export interface PythonReauthResult {
  readonly sso: string;
  readonly token: Record<string, unknown>;
}

export class PythonReauthClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PythonReauthClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async reauthenticate(email: string, password: string): Promise<PythonReauthResult> {
    await this.waitUntilReady();
    const response = await this.fetchImpl(`${this.options.serviceUrl}/internal/registration/v1/reauth`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}) },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    const value = await response.json().catch(() => null) as unknown;
    const payload = value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : {};
    if (!response.ok) {
      const detail = typeof payload.detail === "string" ? payload.detail.slice(0, 400) : `HTTP ${response.status}`;
      throw new Error(`legacy reauthentication worker failed: ${detail}`);
    }
    const sso = typeof payload.sso === "string" ? payload.sso.trim() : "";
    if (!sso) throw new Error("legacy reauthentication worker returned no SSO token");
    const token = payload.token && !Array.isArray(payload.token) && typeof payload.token === "object"
      ? payload.token as Record<string, unknown>
      : {};
    if (typeof token.access_token !== "string" || !token.access_token.trim()) {
      throw new Error("legacy reauthentication worker returned no OAuth access token");
    }
    return { sso, token };
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + Math.min(this.options.timeoutMs, 300_000);
    const retryMs = Math.max(1, this.options.readinessRetryMs ?? 2_000);
    while (Date.now() < deadline) {
      try {
        const remaining = deadline - Date.now();
        const response = await this.fetchImpl(`${this.options.serviceUrl}/health`, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, remaining))),
        });
        if (response.ok) return;
      } catch {
        // The sidecar can still be pulling or restarting; retry until the bounded deadline.
      }
      await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
    throw new Error("legacy reauthentication worker is unavailable");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
