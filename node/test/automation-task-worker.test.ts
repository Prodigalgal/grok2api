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
