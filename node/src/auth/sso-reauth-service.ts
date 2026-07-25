import type { AppConfig } from "../config.js";
import { createHash } from "node:crypto";
import type { SqliteStore } from "../storage/sqlite-store.js";
import { DeviceLoginService } from "./device-login-service.js";

export interface SsoReauthServiceOptions {
  readonly store: SqliteStore;
  readonly deviceLogins: DeviceLoginService;
  readonly config: Pick<AppConfig, "oidcDeviceUrl" | "oidcTokenUrl" | "oidcClientId" | "oidcScopes" | "grokClientVersion">;
  readonly fetchImpl?: typeof fetch;
  readonly pollTimeoutMs?: number;
}

export class SsoReauthService {
  private readonly fetchImpl: typeof fetch;
  private readonly pollTimeoutMs: number;

  constructor(private readonly options: SsoReauthServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 45_000;
  }

  async reauthenticate(accountId: string): Promise<{ readonly accountId: string }> {
    const account = this.options.store.getAccount(accountId);
    if (!account) {
      throw new Error("account was not found");
    }
    const sso = ssoValue(account.payload);
    if (!sso) {
      throw new Error("no saved SSO cookie");
    }
    const restored = await this.restoreFromSsoCookie(account.id, sso);
    return { accountId: restored.accountId };
  }

  async registerFromSsoCookie(ssoCookie: string, email: string | null = null, tokenData?: Record<string, unknown>): Promise<{ readonly accountId: string; readonly email: string | null }> {
    const sso = normalizeSso(ssoCookie);
    if (!sso) {
      throw new Error("authenticated browser session did not contain an SSO cookie");
    }
    const token = stringValue(tokenData?.access_token) ? tokenData! : await this.exchangeSsoCookie(sso);
    const restored = this.options.deviceLogins.restoreTokens(null, token, this.options.config.oidcClientId);
    const saved = this.persistSso(restored.id, sso, email, "browser-registration");
    return { accountId: saved.id, email: saved.email };
  }

  async registerPendingAccount(ssoCookie: string, email: string, password: string): Promise<{ readonly accountId: string; readonly email: string | null }> {
    const sso = normalizeSso(ssoCookie);
    const address = email.trim().toLowerCase();
    if (!sso || !address || !password.trim()) {
      throw new Error("pending registration requires SSO, email, and password");
    }
    const accountId = `pending:xai:${createHash("sha256").update(address).digest("hex").slice(0, 32)}`;
    this.options.store.saveAccount({
      id: accountId,
      email: address,
      userId: null,
      teamId: null,
      payload: {
        email: address,
        password: password.trim(),
        register_password: password.trim(),
        sso,
        sso_cookie: sso,
        auth_mode: "oidc",
        source: "registration-pending-auth",
      },
      expiresAt: 0,
    });
    this.options.store.automationTasks().enqueue(
      "sso_email_reauth",
      `sso_email_reauth:registration:${accountId}:${Date.now()}`,
      { accountId, trigger: "registration_pending_auth" },
    );
    this.options.store.markSsoReauthQueued(accountId);
    return { accountId, email: address };
  }

  async restoreFromSsoCookie(accountId: string, ssoCookie: string, tokenData?: Record<string, unknown>): Promise<{ readonly accountId: string; readonly email: string | null }> {
    const account = this.options.store.getAccount(accountId);
    if (!account) {
      throw new Error("account was not found");
    }
    const sso = normalizeSso(ssoCookie);
    if (!sso) {
      throw new Error("authenticated browser session did not contain an SSO cookie");
    }
    const token = stringValue(tokenData?.access_token) ? tokenData! : await this.exchangeSsoCookie(sso);
    const restored = this.options.deviceLogins.restoreTokens(account.id, token, this.options.config.oidcClientId);
    const saved = this.persistSso(restored.id, sso, account.email, "browser-email-relogin");
    return { accountId: saved.id, email: saved.email };
  }

  private async exchangeSsoCookie(sso: string): Promise<Record<string, unknown>> {
    const cookies = new CookieJar(sso);
    const session = await this.request("https://accounts.x.ai/", { method: "GET" }, cookies);
    if (!session.ok || /sign-(?:in|up)/i.test(session.url)) {
      throw new Error("saved SSO cookie is no longer valid");
    }

    const device = await this.requestForm(this.options.config.oidcDeviceUrl, {
      client_id: this.options.config.oidcClientId,
      scope: this.options.config.oidcScopes,
      referrer: "grok-build",
    }, cookies, true);
    const devicePayload = await objectJson(device, "device code response");
    const deviceCode = stringValue(devicePayload.device_code);
    const userCode = stringValue(devicePayload.user_code);
    if (!device.ok || !deviceCode || !userCode) {
      throw new Error("SSO recovery could not start device authorization");
    }
    const verificationUrl = stringValue(devicePayload.verification_uri_complete)
      || stringValue(devicePayload.verification_uri);
    if (!verificationUrl) {
      throw new Error("SSO recovery device authorization did not include a verification URL");
    }
    await this.request(verificationUrl, { method: "GET" }, cookies);
    const issuer = new URL(this.options.config.oidcDeviceUrl).origin;
    const verification = await this.requestForm(`${issuer}/oauth2/device/verify`, { user_code: userCode }, cookies);
    if (!verification.ok || !/consent/i.test(verification.url)) {
      throw new Error("SSO recovery device verification was rejected");
    }
    const approval = await this.requestForm(`${issuer}/oauth2/device/approve`, {
      user_code: userCode,
      action: "allow",
      principal_type: "User",
      principal_id: "",
    }, cookies);
    if (!approval.ok || !/done/i.test(approval.url)) {
      throw new Error("SSO recovery device approval was rejected");
    }

    return this.pollToken(deviceCode, cookies, boundedNumber(devicePayload.interval, 1, 1, 10));
  }

  private persistSso(accountId: string, sso: string, email: string | null, source: string) {
    const account = this.options.store.getAccount(accountId);
    if (!account) {
      throw new Error("SSO token exchange did not persist an account");
    }
    return this.options.store.recordRefreshSuccess({
      id: account.id,
      email: email?.trim() || account.email,
      userId: account.userId,
      teamId: account.teamId,
      payload: { ...account.payload, sso, sso_cookie: sso, source },
      expiresAt: account.expiresAt,
    });
  }

  private async pollToken(deviceCode: string, cookies: CookieJar, initialIntervalSeconds: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + this.pollTimeoutMs;
    let intervalMs = initialIntervalSeconds * 1_000;
    while (Date.now() < deadline) {
      const response = await this.requestForm(this.options.config.oidcTokenUrl, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: this.options.config.oidcClientId,
      }, cookies, true);
      const payload = await tryObjectJson(response);
      if (response.ok && stringValue(payload?.access_token)) {
        return payload!;
      }
      const error = stringValue(payload?.error);
      if (error === "authorization_pending") {
        await delay(intervalMs);
        continue;
      }
      if (error === "slow_down") {
        intervalMs = Math.min(intervalMs + 1_000, 10_000);
        await delay(intervalMs);
        continue;
      }
      throw new Error(error ? `SSO recovery token exchange failed: ${error}` : `SSO recovery token exchange failed: HTTP ${response.status}`);
    }
    throw new Error("SSO recovery token exchange timed out");
  }

  private async requestForm(url: string, form: Record<string, string>, cookies: CookieJar, grokHeaders = false): Promise<Response> {
    return this.request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(grokHeaders ? {
          "x-grok-client-version": this.options.config.grokClientVersion,
          "x-grok-client-surface": "cli",
        } : {}),
      },
      body: new URLSearchParams(form),
    }, cookies);
  }

  private async request(url: string, init: RequestInit, cookies: CookieJar): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookie = cookies.header();
    if (cookie) {
      headers.set("cookie", cookie);
    }
    const response = await this.fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(30_000) });
    cookies.absorb(response);
    return response;
  }
}

class CookieJar {
  private readonly entries = new Map<string, string>();

  constructor(sso: string) {
    this.entries.set("sso", sso);
  }

  header(): string {
    return [...this.entries.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  absorb(response: Response): void {
    const setCookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : [];
    for (const raw of setCookies) {
      const first = raw.split(";", 1)[0] ?? "";
      const separator = first.indexOf("=");
      if (separator > 0) {
        this.entries.set(first.slice(0, separator).trim(), first.slice(separator + 1).trim());
      }
    }
  }
}

function ssoValue(payload: Record<string, unknown>): string {
  for (const key of ["sso", "sso_cookie", "sso_token"]) {
    const value = stringValue(payload[key]);
    if (value) {
      return value.replace(/^sso\s*=\s*/i, "");
    }
  }
  for (const key of ["session_cookies", "cookies"]) {
    const nested = payload[key];
    if (nested && !Array.isArray(nested) && typeof nested === "object") {
      const values = nested as Record<string, unknown>;
      const value = stringValue(values.sso) || stringValue(values["sso-rw"]);
      if (value) {
        return value;
      }
    }
  }
  for (const key of ["cookie", "cookies", "set_cookie", "set-cookie", "set_cookies"]) {
    const value = stringValue(payload[key]);
    const match = /(?:^|[;,\s])sso(?:-rw)?\s*=\s*([^;,\s]+)/i.exec(value);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "";
}

function normalizeSso(value: string): string {
  return value.trim().replace(/^sso(?:-rw)?\s*=\s*/i, "");
}

async function objectJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const value = await tryObjectJson(response);
  if (!value) {
    throw new Error(`${label} was not valid JSON`);
  }
  return value;
}

async function tryObjectJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await response.clone().json() as unknown;
    return parsed && !Array.isArray(parsed) && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.trunc(value)))
    : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
