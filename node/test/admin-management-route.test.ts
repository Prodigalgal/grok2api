import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApiServer } from "../src/http/health-server.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

test("SQLite admin management requires both credentials and exposes revealable API keys", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grok2api-admin-management-test-"));
  const store = new SqliteStore(join(directory, "app.sqlite"));
  store.migrate();
  store.saveAccount({
    id: "account-1",
    email: "member@example.test",
    userId: "user-1",
    payload: { access_token: "private-access-token", refresh_token: "private-refresh-token" },
    expiresAt: Date.now() + 3_600_000,
  });
  store.recordRefreshFailure("account-1", "Refresh token has been revoked", true);
  store.markSsoReauthFailure("account-1", "saved SSO cookie is no longer valid", 3_600_000);
  const accountReauthTask = store.automationTasks().enqueue("sso_email_reauth", "account-1:reauth-status", { accountId: "account-1" });
  store.saveAccount({ id: "account-banned", email: "banned@example.test", payload: { access_token: "banned-private-token" } });
  store.markSsoReauthBanned("account-banned", "Access denied");
  const deletedAccountId = "https://auth.x.ai::account-delete";
  store.saveAccount({ id: deletedAccountId, email: "delete@example.test", payload: { access_token: "delete-private-token" } });
  const deletedTask = store.automationTasks().enqueue("sso_email_reauth", "account-delete:reauth", { accountId: deletedAccountId });
  const server = createApiServer({
    adminStore: store,
    modelStore: store,
    apiKeyStore: store,
    adminUsername: "admin-test-user",
    adminPassword: "admin-test-password",
  });
  const port = await server.listen("127.0.0.1", 0);
  const adminHeaders = { "x-admin-username": "admin-test-user", "x-admin-password": "admin-test-password" };
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/admin/api/status`);
    assert.equal(denied.status, 401);
    const wrongUser = await fetch(`http://127.0.0.1:${port}/admin/api/status`, { headers: { "x-admin-username": "wrong", "x-admin-password": "admin-test-password" } });
    assert.equal(wrongUser.status, 401);

    const status = await fetch(`http://127.0.0.1:${port}/admin/api/status`, { headers: adminHeaders });
    assert.equal(status.status, 200);
    const statusBody = await status.json() as { store: { backend: string; redis: boolean; postgresql: boolean }; accounts: { account_count: number } };
    assert.deepEqual(statusBody.store, { backend: "sqlite", redis: false, postgresql: false });
    assert.equal(statusBody.accounts.account_count, 3);

    const accounts = await fetch(`http://127.0.0.1:${port}/admin/api/accounts?q=member`, { headers: adminHeaders });
    assert.equal(accounts.status, 200);
    const accountsText = await accounts.text();
    assert.match(accountsText, /member@example\.test/);
    assert.equal(accountsText.includes("private-access-token"), false);
    assert.equal(accountsText.includes("private-refresh-token"), false);
    assert.match(accountsText, /"hasEmailMailbox":false/);
    const accountsBody = JSON.parse(accountsText) as { accounts: Array<Record<string, unknown>> };
    assert.equal(accountsBody.accounts[0]?.lastRenewStatus, "sso_failed");
    assert.equal(accountsBody.accounts[0]?.renewFailCount, 1);
    assert.equal(accountsBody.accounts[0]?.reauthTaskStatus, "queued");
    assert.equal(typeof accountsBody.accounts[0]?.ssoReauthNextAt, "number");

    const bannedAccounts = await fetch(`http://127.0.0.1:${port}/admin/api/accounts?status=banned`, { headers: adminHeaders });
    assert.equal(bannedAccounts.status, 200);
    const bannedBody = await bannedAccounts.json() as { total: number; pool: { banned: number }; accounts: Array<{ id: string }> };
    assert.equal(bannedBody.total, 1);
    assert.equal(bannedBody.pool.banned, 1);
    assert.equal(bannedBody.accounts[0]?.id, "account-banned");

    const disabled = await fetch(`http://127.0.0.1:${port}/admin/api/accounts/account-1/enabled`, {
      method: "PATCH",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json() as { account: { enabled: boolean } }).account.enabled, false);

    const deleted = await fetch(`http://127.0.0.1:${port}/admin/api/accounts/delete`, {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ id: deletedAccountId }),
    });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json() as { cancelled_tasks: number }).cancelled_tasks, 1);
    assert.equal(store.getAccountSummary(deletedAccountId), null);
    assert.equal(store.automationTasks().get(deletedTask.id)?.status, "cancelled");

    store.automationTasks().cancelPending(accountReauthTask.id);
    store.saveAccount({ id: "account-active-delete", email: "active-delete@example.test", payload: { access_token: "active-delete-token" } });
    const activeDeleteTask = store.automationTasks().enqueue("sso_email_reauth", "active-delete:reauth", { accountId: "account-active-delete" });
    store.automationTasks().claimNext("active-delete-worker", 60_000, Date.now(), ["sso_email_reauth"]);
    store.automationTasks().markRunning(activeDeleteTask.id, "active-delete-worker");
    const activeDelete = await fetch(`http://127.0.0.1:${port}/admin/api/accounts/delete`, {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ id: "account-active-delete" }),
    });
    assert.equal(activeDelete.status, 409);
    assert.notEqual(store.getAccountSummary("account-active-delete"), null);

    const created = await fetch(`http://127.0.0.1:${port}/admin/api/keys`, {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "automation" }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { key: { id: string; prefix: string }; secret: string };
    assert.equal(createdBody.secret.startsWith(createdBody.key.prefix), true);

    const keyList = await fetch(`http://127.0.0.1:${port}/admin/api/keys`, { headers: adminHeaders });
    assert.equal(keyList.status, 200);
    assert.equal((await keyList.text()).includes(createdBody.secret), true);

    const authorizedModels = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${createdBody.secret}` },
    });
    assert.equal(authorizedModels.status, 200);

    const rotated = await fetch(`http://127.0.0.1:${port}/admin/api/keys/${createdBody.key.id}/regenerate`, {
      method: "POST",
      headers: adminHeaders,
    });
    assert.equal(rotated.status, 200);
    const rotatedBody = await rotated.json() as { secret: string };
    assert.notEqual(rotatedBody.secret, createdBody.secret);
    const oldKey = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${createdBody.secret}` } });
    assert.equal(oldKey.status, 401);
    const newKey = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${rotatedBody.secret}` } });
    assert.equal(newKey.status, 200);
    const rotatedList = await fetch(`http://127.0.0.1:${port}/admin/api/keys`, { headers: adminHeaders });
    assert.equal((await rotatedList.text()).includes(rotatedBody.secret), true);
  } finally {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
