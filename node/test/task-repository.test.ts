import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { AutomationTaskRepository } from "../src/automation/task-repository.js";
import { migrations } from "../src/storage/migrations.js";

function createRepository(): { readonly db: DatabaseSync; readonly repo: AutomationTaskRepository; readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "grok2api-task-test-"));
  const db = new DatabaseSync(join(dir, "app.sqlite"));
  for (const migration of migrations) {
    db.exec(migration.sql);
  }
  return { db, repo: new AutomationTaskRepository(db), dir };
}

test("automation tasks are idempotent and recover expired leases", () => {
  const { db, repo, dir } = createRepository();
  try {
    const first = repo.enqueue("sso_reauth", "idempotency-1", { accountId: "a-1" }, 1_000);
    const duplicate = repo.enqueue("sso_reauth", "idempotency-1", { accountId: "a-1" }, 1_001);
    assert.equal(first.id, duplicate.id);

    const leased = repo.claimNext("worker-a", 50, 1_010);
    assert.equal(leased?.status, "leased");
    assert.equal(leased?.attempts, 1);
    const running = repo.markRunning(first.id, "worker-a", 1_020);
    assert.equal(running.status, "running");

    assert.equal(repo.recoverExpired(1_100), 1);
    const reclaimed = repo.claimNext("worker-b", 50, 1_110);
    assert.equal(reclaimed?.id, first.id);
    assert.equal(reclaimed?.attempts, 2);
    const completed = repo.succeed(first.id, "worker-b", { accountId: "a-1", refreshed: true }, 1_120);
    assert.equal(completed.status, "succeeded");
    assert.deepEqual(completed.result, { accountId: "a-1", refreshed: true });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idempotency rejects a mismatched task payload", () => {
  const { db, repo, dir } = createRepository();
  try {
    repo.enqueue("registration", "same-key", { count: 1 });
    assert.throws(() => repo.enqueue("registration", "same-key", { count: 2 }));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending tasks can be listed and cancelled without racing an active worker", () => {
  const { db, repo, dir } = createRepository();
  try {
    const queued = repo.enqueue("registration", "cancel-queued", { browser: { url: "https://example.test" } }, 1_000);
    const waiting = repo.enqueue("sso_reauth", "cancel-waiting", { accountId: "account-1" }, 1_001);
    const leased = repo.claimNext("worker-a", 10_000, 1_002);
    assert.equal(leased?.id, queued.id);
    assert.equal(repo.list({ status: "queued" }).map((task) => task.id).includes(waiting.id), true);
    const cancelled = repo.cancelPending(waiting.id, 1_003);
    assert.equal(cancelled.status, "cancelled");
    assert.throws(() => repo.cancelPending(queued.id), /cannot be cancelled while leased/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registration tasks are claimed before background reauthorization", () => {
  const { db, repo, dir } = createRepository();
  try {
    repo.enqueue("sso_email_reauth", "background-reauth", { accountId: "account-1" }, 1_000);
    const registration = repo.enqueue("registration", "interactive-registration", { browser: {} }, 2_000);
    assert.equal(repo.claimNext("worker-a", 10_000, 3_000)?.id, registration.id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dedicated workers only claim their configured task kinds", () => {
  const { db, repo, dir } = createRepository();
  try {
    const reauth = repo.enqueue("sso_email_reauth", "dedicated-reauth", { accountId: "account-1" }, 1_000);
    const registration = repo.enqueue("registration", "dedicated-registration", { browser: {} }, 1_001);
    assert.equal(repo.claimNext("reauth-worker", 10_000, 2_000, ["sso_reauth", "sso_email_reauth"])?.id, reauth.id);
    assert.equal(repo.claimNext("registration-worker", 10_000, 2_001, ["registration"])?.id, registration.id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("running registration tasks record logs and can be cancelled by their owner", () => {
  const { db, repo, dir } = createRepository();
  try {
    const task = repo.enqueue("registration", "cancel-running", { browser: {} }, 1_000);
    repo.claimNext("worker-a", 10_000, 1_001);
    repo.markRunning(task.id, "worker-a", 1_002);
    repo.appendEvent(task.id, "worker_running", { message: "registration started" }, 1_003);
    assert.deepEqual(repo.events(task.id).map((event) => event.type), ["running", "worker_running"]);
    assert.equal(repo.cancelRunning(task.id, "worker-a", 1_004).status, "cancelled");
    assert.equal(repo.events(task.id).at(-1)?.type, "cancelled");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
