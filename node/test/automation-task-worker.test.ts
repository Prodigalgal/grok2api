import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AutomationTaskWorker } from "../src/automation/task-worker.js";
import { SqliteStore } from "../src/storage/sqlite-store.js";

function createStore(): { readonly store: SqliteStore; readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "grok2api-task-worker-test-"));
  const store = new SqliteStore(join(dir, "app.sqlite"));
  store.migrate();
  return { store, dir };
}

test("failed saved SSO recovery succeeds after queuing independent email reauthorization", async () => {
  const { store, dir } = createStore();
  try {
    store.saveAccount({
      id: "account-sso-recover",
      payload: { key: "expired", refresh_token: "refresh", sso_cookie: "expired-sso", refresh_invalid: true },
      expiresAt: Date.now() - 1_000,
    });
    const task = store.automationTasks().enqueue("sso_reauth", "sso_reauth:account-sso-recover:1", {
      accountId: "account-sso-recover",
    });
    const worker = new AutomationTaskWorker({
      store,
      ssoReauth: { reauthenticate: async () => { throw new Error("saved SSO cookie is no longer valid"); } },
      browserRunner: { run: async () => ({}) },
      config: { workerLeaseMs: 10_000, ssoReauthCooldownMs: 3_600_000 },
      owner: "test-worker",
    });

    await worker.runOnce();
    const failed = store.automationTasks().get(task.id);
    assert.equal(failed?.status, "succeeded");
    assert.equal(failed?.result?.recoveredBy, "email_queued");
    const queued = store.automationTasks().listByStatus("queued", "sso_email_reauth");
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.request.accountId, "account-sso-recover");
    assert.deepEqual(queued[0]?.request.browser, {
      url: "https://accounts.x.ai/sign-in",
      actions: [{ type: "xai_email_login" }],
    });
    assert.equal(store.automationTasks().listByStatus("waiting_input").length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("long registration work renews its lease until completion", async () => {
  const { store, dir } = createStore();
  try {
    const task = store.automationTasks().enqueue("registration", "registration:lease-heartbeat", { count: 1, concurrency: 1 });
    const worker = new AutomationTaskWorker({
      store,
      ssoReauth: { reauthenticate: async () => ({ accountId: "unused" }) },
      browserRunner: { run: async () => ({}) },
      registrationRunner: { run: async () => { await new Promise((resolve) => setTimeout(resolve, 140)); return { accountId: "account-1" }; } },
      config: { workerLeaseMs: 60, ssoReauthCooldownMs: 3_600_000 },
      owner: "registration-heartbeat-worker",
      kinds: ["registration"],
    });
    const running = worker.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(store.automationTasks().recoverExpired(), 0);
    await running;
    assert.equal(store.automationTasks().get(task.id)?.status, "succeeded");
    assert.equal(store.automationTasks().get(task.id)?.attempts, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lost task lease cannot crash the automation worker", async () => {
  const { store, dir } = createStore();
  try {
    const task = store.automationTasks().enqueue("registration", "registration:lost-lease", { count: 1, concurrency: 1 });
    let rejectRun: ((error: Error) => void) | undefined;
    const worker = new AutomationTaskWorker({
      store,
      ssoReauth: { reauthenticate: async () => ({ accountId: "unused" }) },
      browserRunner: { run: async () => ({}) },
      registrationRunner: { run: () => new Promise((_, reject) => { rejectRun = reject; }) },
      config: { workerLeaseMs: 10_000, ssoReauthCooldownMs: 3_600_000 },
      owner: "lost-lease-worker",
      kinds: ["registration"],
    });

    const running = worker.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    store.automationTasks().cancelRunning(task.id, "lost-lease-worker");
    rejectRun?.(new Error("runner completed after cancellation"));
    await running;
    assert.equal(store.automationTasks().get(task.id)?.status, "cancelled");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
