import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeviceLoginService } from "../src/auth/device-login-service.js";
import { SsoReauthService } from "../src/auth/sso-reauth-service.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

function response(body: Record<string, unknown> | string, url: string): Response {
  const result = new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

test("authenticated browser SSO cookie is converted into a durable SQLite account without task-result leakage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grok2api-sso-registration-test-"));
  const store = new SqliteStore(join(directory, "app.sqlite"));
  store.migrate();
  const accessToken = ["header", Buffer.from(JSON.stringify({ principal_id: "user-1", email: "member@example.test", exp: 1_900_000_000 })).toString("base64url"), "signature"].join(".");
  let sessionCookie = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://accounts.x.ai/") {
      sessionCookie = String(new Headers(init?.headers).get("cookie") ?? "");
      return response("", url);
    }
    if (url.endsWith("/device/code")) {
      return response({ device_code: "private-device-code", user_code: "AB-12", verification_uri_complete: "https://auth.example.test/verify", interval: 1 }, url);
    }
    if (url === "https://auth.example.test/verify") {
      return response("", url);
    }
    if (url.endsWith("/device/verify")) {
      return response("", "https://auth.example.test/consent");
    }
    if (url.endsWith("/device/approve")) {
      return response("", "https://auth.example.test/done");
    }
    if (url.endsWith("/token")) {
      return response({ access_token: accessToken, refresh_token: "private-refresh-token", expires_in: 3600 }, url);
    }
    throw new Error(`unexpected SSO request ${url}`);
  };
  const config = {
    oidcDeviceUrl: "https://auth.example.test/device/code",
    oidcTokenUrl: "https://auth.example.test/token",
    oidcClientId: "test-client",
    oidcScopes: "openid offline_access",
    grokClientVersion: "0.2.112",
  };
  const deviceLogins = new DeviceLoginService({ store, config, autoPoll: false, fetchImpl });
  const service = new SsoReauthService({ store, deviceLogins, config, fetchImpl });
  try {
    const output = await service.registerFromSsoCookie("sso=private-browser-sso", "registered@example.test");
    assert.equal(output.accountId, "https://auth.x.ai::user-1");
    assert.equal(output.email, "registered@example.test");
    assert.match(sessionCookie, /sso=private-browser-sso/);
    assert.equal(JSON.stringify(output).includes("private-browser-sso"), false);
    assert.equal(JSON.stringify(output).includes("private-refresh-token"), false);
    const account = store.getAccount(output.accountId);
    assert.equal(account?.email, "registered@example.test");
    assert.equal(account?.payload.sso, "private-browser-sso");
    assert.equal(account?.payload.refresh_token, "private-refresh-token");
    store.saveCloudflareMailboxCredential(output.accountId, {
      id: "mailbox-1",
      address: "registered@example.test",
      accessToken: "private-mailbox-jwt",
    });
    assert.equal(store.getCloudflareMailboxCredential(output.accountId)?.address, "registered@example.test");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("protocol registration token is persisted without another Cloudflare request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grok2api-protocol-registration-test-"));
  const store = new SqliteStore(join(directory, "app.sqlite"));
  store.migrate();
  const accessToken = ["header", Buffer.from(JSON.stringify({ principal_id: "user-3", email: "new@example.test", exp: 1_900_000_000 })).toString("base64url"), "signature"].join(".");
  const config = {
    oidcDeviceUrl: "https://auth.example.test/device/code",
    oidcTokenUrl: "https://auth.example.test/token",
    oidcClientId: "test-client",
    oidcScopes: "openid offline_access",
    grokClientVersion: "0.2.112",
  };
  const fetchImpl: typeof fetch = async () => { throw new Error("Cloudflare request must not run"); };
  const deviceLogins = new DeviceLoginService({ store, config, autoPoll: false, fetchImpl });
  const service = new SsoReauthService({ store, deviceLogins, config, fetchImpl });
  try {
    const output = await service.registerFromSsoCookie("private-sso", "new@example.test", {
      access_token: accessToken,
      refresh_token: "private-refresh-token",
      expires_in: 3600,
    });
    const account = store.getAccount(output.accountId);
    assert.equal(account?.payload.sso, "private-sso");
    assert.equal(account?.payload.refresh_token, "private-refresh-token");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pending registration is durable and immediately queues automatic reauthorization", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grok2api-pending-registration-test-"));
  const store = new SqliteStore(join(directory, "app.sqlite"));
  store.migrate();
  const config = {
    oidcDeviceUrl: "https://auth.example.test/device/code",
    oidcTokenUrl: "https://auth.example.test/token",
    oidcClientId: "test-client",
    oidcScopes: "openid offline_access",
    grokClientVersion: "0.2.112",
  };
  const deviceLogins = new DeviceLoginService({ store, config, autoPoll: false });
  const service = new SsoReauthService({ store, deviceLogins, config });
  try {
    const output = await service.registerPendingAccount("pending-sso", "pending@example.test", "private-password");
    assert.equal(store.getAccount(output.accountId)?.expiresAt, 0);
    assert.equal(store.automationTasks().listByStatus("queued", "sso_email_reauth").length, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy protocol token restores an account without another Cloudflare request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grok2api-protocol-reauth-test-"));
  const store = new SqliteStore(join(directory, "app.sqlite"));
  store.migrate();
  const accessToken = ["header", Buffer.from(JSON.stringify({ principal_id: "user-2", email: "member@example.test", exp: 1_900_000_000 })).toString("base64url"), "signature"].join(".");
  store.saveAccount({
    id: "account-2",
    email: "member@example.test",
    userId: "user-2",
    teamId: null,
    payload: { key: "expired-token" },
    expiresAt: 1,
  });
  const config = {
    oidcDeviceUrl: "https://auth.example.test/device/code",
    oidcTokenUrl: "https://auth.example.test/token",
    oidcClientId: "test-client",
    oidcScopes: "openid offline_access",
    grokClientVersion: "0.2.112",
  };
  const fetchImpl: typeof fetch = async () => { throw new Error("Cloudflare request must not run"); };
  const deviceLogins = new DeviceLoginService({ store, config, autoPoll: false, fetchImpl });
  const service = new SsoReauthService({ store, deviceLogins, config, fetchImpl });
  try {
    const output = await service.restoreFromSsoCookie("account-2", "private-sso", {
      access_token: accessToken,
      refresh_token: "private-refresh-token",
      expires_in: 3600,
    });
    assert.equal(output.accountId, "account-2");
    const account = store.getAccount("account-2");
    assert.equal(account?.payload.sso, "private-sso");
    assert.equal(account?.payload.refresh_token, "private-refresh-token");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
