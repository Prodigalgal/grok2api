import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApiServer } from "../src/http/health-server.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

test("Node admin operations persist settings and expose import, export, logs, usage, and maintenance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grok2api-admin-operations-"));
  const store = new SqliteStore(join(directory, "app.sqlite"));
  store.migrate();
  store.recordUsageBatch([{ requestId: "req-1", accountId: "account-1", model: "grok-4.5", protocol: "responses", success: true, promptTokens: 8, completionTokens: 3, totalTokens: 11 }]);
  store.automationTasks().enqueue("browser_automation", "browser:test", { browser: { url: "https://example.test" } });
  let maintenanceRuns = 0;
  const server = createApiServer({
    adminStore: store,
    automationTasks: store.automationTasks(),
    registrationDefaults: { mailBaseUrl: "https://mail.example.test", mailDomain: "mail.example.test", maxConcurrency: 3 },
    reauthConcurrency: 4,
    adminUsername: "admin",
    adminPassword: "secret",
    maintainer: { async runOnce(force) { assert.equal(force, true); maintenanceRuns++; return { attempted: 0, refreshed: 0, failed: 0, permanentFailures: 0, ssoTasksQueued: 0 }; } },
  });
  const port = await server.listen("127.0.0.1", 0);
  const headers = { "x-admin-username": "admin", "x-admin-password": "secret" };
  const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { ...headers, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
  try {
    const settings = await call("/admin/api/settings", { method: "PATCH", body: JSON.stringify({ settings: { default_model: "grok-4.5", account_mode: "least_used" } }) });
    assert.equal(settings.status, 200);
    assert.equal(store.getSetting("account_mode"), "least_used");
    const removed = await call("/admin/api/settings", { method: "PATCH", body: JSON.stringify({ sub2api_url: "https://removed.test" }) });
    assert.equal(removed.status, 400);

    const imported = await call("/admin/api/accounts/import", { method: "POST", body: JSON.stringify({ auth: { "account-1": { email: "member@example.test", access_token: "private", expires_at: Math.floor(Date.now() / 1000) + 3600 } } }) });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json() as { imported: number }).imported, 1);
    const exported = await call("/admin/api/accounts/export");
    assert.equal(exported.status, 200);
    assert.equal(((await exported.json()) as { auth: Record<string, unknown> }).auth["account-1"] !== undefined, true);

    assert.equal((await call("/admin/api/usage/series?days=7")).status, 200);
    assert.equal((await call("/admin/api/usage/by-model")).status, 200);
    const logs = await call("/admin/api/logs");
    assert.match(await logs.text(), /browser_automation/);
    const maintenance = await call("/admin/api/maintainer/run", { method: "POST" });
    const maintenanceText = await maintenance.text();
    assert.equal(maintenance.status, 200, maintenanceText);
    assert.equal(maintenanceRuns, 1);

    const registration = await call("/admin/api/accounts/register", { method: "POST", body: JSON.stringify({ count: 12, concurrency: 3 }) });
    assert.equal(registration.status, 202);
    const registrationBody = await registration.json() as { count: number; concurrency: number; tasks: Array<{ batch: { count: number; concurrency: number } }> };
    assert.equal(registrationBody.count, 12);
    assert.equal(registrationBody.concurrency, 3);
    assert.equal(registrationBody.tasks.length, 1);
    assert.deepEqual(registrationBody.tasks[0]?.batch, { count: 12, concurrency: 3 });
    assert.equal(store.automationTasks().listByStatus("queued", "registration").length, 1);
    assert.equal((await call("/admin/api/accounts/register", { method: "POST", body: JSON.stringify({ count: 12, concurrency: 4 }) })).status, 400);
  } finally {
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
