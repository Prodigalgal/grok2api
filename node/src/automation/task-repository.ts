import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const taskStates = ["queued", "leased", "running", "waiting_input", "succeeded", "failed", "cancelled"] as const;
export type TaskState = (typeof taskStates)[number];

export interface AutomationTask {
  readonly id: string;
  readonly kind: string;
  readonly status: TaskState;
  readonly idempotencyKey: string;
  readonly request: Record<string, unknown>;
  readonly result: Record<string, unknown> | null;
  readonly error: string | null;
  readonly attempts: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly finishedAt: number | null;
}

export interface AutomationTaskEvent {
  readonly id: number;
  readonly type: string;
  readonly detail: Record<string, unknown>;
  readonly createdAt: number;
}

interface TaskRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly idempotency_key: string;
  readonly request_json: string;
  readonly result_json: string | null;
  readonly error: string | null;
  readonly attempts: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly finished_at: number | null;
}

function objectJson(value: string | null): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("task JSON must be an object");
  }
  return parsed as Record<string, unknown>;
}

function toTask(row: TaskRow): AutomationTask {
  if (!taskStates.includes(row.status as TaskState)) {
    throw new Error(`invalid task state ${row.status}`);
  }
  const request = objectJson(row.request_json);
  if (!request) {
    throw new Error("task request is required");
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as TaskState,
    idempotencyKey: row.idempotency_key,
    request,
    result: objectJson(row.result_json),
    error: row.error,
    attempts: row.attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export class AutomationTaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  enqueue(kind: string, idempotencyKey: string, request: Record<string, unknown>, now = Date.now()): AutomationTask {
    if (!kind.trim() || !idempotencyKey.trim()) {
      throw new Error("task kind and idempotency key are required");
    }
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO automation_tasks(id, kind, status, idempotency_key, request_json, created_at, updated_at)
      VALUES (?, ?, 'queued', ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(id, kind, idempotencyKey, JSON.stringify(request), now, now);
    const task = this.findByIdempotencyKey(idempotencyKey);
    if (!task) {
      throw new Error("task was not persisted");
    }
    if (task.kind !== kind || JSON.stringify(task.request) !== JSON.stringify(request)) {
      throw new Error("idempotency key was already used for a different task");
    }
    return task;
  }

  get(id: string): AutomationTask | null {
    const row = this.db.prepare("SELECT * FROM automation_tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  getByIdempotencyKey(idempotencyKey: string): AutomationTask | null {
    return this.findByIdempotencyKey(idempotencyKey);
  }

  listByStatus(status: TaskState, kind?: string): AutomationTask[] {
    const rows = kind
      ? this.db.prepare("SELECT * FROM automation_tasks WHERE status = ? AND kind = ? ORDER BY created_at, id").all(status, kind)
      : this.db.prepare("SELECT * FROM automation_tasks WHERE status = ? ORDER BY created_at, id").all(status);
    return (rows as unknown as TaskRow[]).map(toTask);
  }

  list(options: { readonly status?: TaskState; readonly limit?: number } = {}): AutomationTask[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const rows = options.status
      ? this.db.prepare("SELECT * FROM automation_tasks WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(options.status, limit)
      : this.db.prepare("SELECT * FROM automation_tasks ORDER BY created_at DESC, id DESC LIMIT ?").all(limit);
    return (rows as unknown as TaskRow[]).map(toTask);
  }

  listActiveForAccount(accountId: string): AutomationTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM automation_tasks
      WHERE json_extract(request_json, '$.accountId') = ?
        AND status IN ('queued', 'leased', 'running', 'waiting_input')
      ORDER BY created_at, id
    `).all(accountId) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  cancelPendingForAccount(accountId: string, now = Date.now()): number {
    let cancelled = 0;
    for (const task of this.listActiveForAccount(accountId)) {
      if (task.status !== "queued" && task.status !== "waiting_input") continue;
      try {
        this.cancelPending(task.id, now);
        cancelled++;
      } catch {
        // A worker may claim the task between listing and cancellation.
      }
    }
    return cancelled;
  }

  cancelPending(id: string, now = Date.now()): AutomationTask {
    const task = this.get(id);
    if (!task) {
      throw new Error(`task ${id} was not found`);
    }
    if (task.status !== "queued" && task.status !== "waiting_input") {
      throw new Error(`task ${id} cannot be cancelled while ${task.status}`);
    }
    this.db.prepare(`
      UPDATE automation_tasks
      SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
          error = NULL, updated_at = ?, finished_at = ?
      WHERE id = ? AND status IN ('queued', 'waiting_input')
    `).run(now, now, id);
    this.db.prepare(`
      INSERT INTO automation_task_events(task_id, event_type, detail_json, created_at)
      VALUES (?, 'cancelled', '{"reason":"operator"}', ?)
    `).run(id, now);
    return this.mustGet(id);
  }

  cancelRunning(id: string, owner: string, now = Date.now()): AutomationTask {
    const task = this.get(id);
    if (!task || task.status !== "running" || task.leaseOwner !== owner) {
      throw new Error(`task ${id} is not running under ${owner}`);
    }
    this.db.prepare(`
      UPDATE automation_tasks SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
        error = NULL, updated_at = ?, finished_at = ? WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(now, now, id, owner);
    this.appendEvent(id, "cancelled", { reason: "operator" }, now);
    return this.mustGet(id);
  }

  appendEvent(id: string, type: string, detail: Record<string, unknown>, now = Date.now()): void {
    this.db.prepare(`INSERT INTO automation_task_events(task_id, event_type, detail_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, type.slice(0, 80), JSON.stringify(detail), now);
  }

  events(id: string, limit = 200): AutomationTaskEvent[] {
    const rows = this.db.prepare(`
      SELECT id, event_type, detail_json, created_at FROM automation_task_events
      WHERE task_id = ? ORDER BY id DESC LIMIT ?
    `).all(id, Math.max(1, Math.min(limit, 500))) as Array<{ id: number; event_type: string; detail_json: string; created_at: number }>;
    return rows.reverse().map((row) => ({
      id: row.id,
      type: row.event_type,
      detail: objectJson(row.detail_json) ?? {},
      createdAt: row.created_at,
    }));
  }

  recoverExpired(now = Date.now()): number {
    const result = this.db.prepare(`
      UPDATE automation_tasks
      SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE status IN ('leased', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).run(now, now);
    return Number(result.changes);
  }

  claimNext(owner: string, leaseMs: number, now = Date.now(), kinds: readonly string[] = []): AutomationTask | null {
    if (!owner.trim() || leaseMs <= 0) {
      throw new Error("task owner and positive lease duration are required");
    }
    this.recoverExpired(now);
    const allowedKinds = kinds.map((kind) => kind.trim()).filter(Boolean);
    const kindFilter = allowedKinds.length ? `AND kind IN (${allowedKinds.map(() => "?").join(", ")})` : "";
    const candidate = this.db.prepare(`
      SELECT id FROM automation_tasks
      WHERE status = 'queued'
      ${kindFilter}
      ORDER BY CASE WHEN kind = 'registration' THEN 0 ELSE 1 END, created_at, id
      LIMIT 1
    `).get(...allowedKinds) as { id: string } | undefined;
    if (!candidate) {
      return null;
    }
    const result = this.db.prepare(`
      UPDATE automation_tasks
      SET status = 'leased', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(owner, now + leaseMs, now, candidate.id);
    if (result.changes !== 1) {
      return null;
    }
    return this.get(candidate.id);
  }

  markRunning(id: string, owner: string, now = Date.now()): AutomationTask {
    return this.transition(id, owner, ["leased"], "running", now);
  }

  renewLease(id: string, owner: string, leaseMs: number, now = Date.now()): boolean {
    if (!owner.trim() || leaseMs <= 0) return false;
    const result = this.db.prepare(`
      UPDATE automation_tasks SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND status IN ('leased', 'running')
    `).run(now + leaseMs, now, id, owner);
    return result.changes === 1;
  }

  waitForInput(id: string, owner: string, detail: Record<string, unknown>, now = Date.now()): AutomationTask {
    const task = this.transition(id, owner, ["running"], "waiting_input", now, detail, detail);
    this.db.prepare("UPDATE automation_tasks SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ?").run(id);
    return this.mustGet(id, task);
  }

  succeed(id: string, owner: string, result: Record<string, unknown>, now = Date.now()): AutomationTask {
    return this.transition(id, owner, ["leased", "running"], "succeeded", now, result);
  }

  fail(id: string, owner: string, error: string, now = Date.now()): AutomationTask {
    if (!error.trim()) {
      throw new Error("task error is required");
    }
    return this.transition(id, owner, ["leased", "running"], "failed", now, null, { error });
  }

  succeedWaitingForInput(id: string, result: Record<string, unknown>, now = Date.now()): AutomationTask {
    const task = this.get(id);
    if (!task || task.status !== "waiting_input") {
      throw new Error(`task ${id} is not waiting for input`);
    }
    this.db.prepare(`
      UPDATE automation_tasks
      SET status = 'succeeded', result_json = ?, error = NULL, lease_owner = NULL,
          lease_expires_at = NULL, updated_at = ?, finished_at = ?
      WHERE id = ? AND status = 'waiting_input'
    `).run(JSON.stringify(result), now, now, id);
    this.db.prepare(`
      INSERT INTO automation_task_events(task_id, event_type, detail_json, created_at) VALUES (?, 'succeeded', ?, ?)
    `).run(id, JSON.stringify(result), now);
    return this.mustGet(id);
  }

  private findByIdempotencyKey(idempotencyKey: string): AutomationTask | null {
    const row = this.db.prepare("SELECT * FROM automation_tasks WHERE idempotency_key = ?").get(idempotencyKey) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  private transition(
    id: string,
    owner: string,
    allowed: readonly TaskState[],
    target: TaskState,
    now: number,
    result: Record<string, unknown> | null = null,
    eventDetail: Record<string, unknown> = {},
  ): AutomationTask {
    const task = this.get(id);
    if (!task) {
      throw new Error(`task ${id} was not found`);
    }
    if (!allowed.includes(task.status) || task.leaseOwner !== owner) {
      throw new Error(`task ${id} is not owned by ${owner} in an allowed state`);
    }
    const terminal = target === "succeeded" || target === "failed" || target === "cancelled";
    const error = target === "failed" ? String(eventDetail.error ?? "task failed") : null;
    this.db.prepare(`
      UPDATE automation_tasks
      SET status = ?, result_json = ?, error = ?, lease_owner = ?, lease_expires_at = ?, updated_at = ?, finished_at = ?
      WHERE id = ?
    `).run(
      target,
      result === null ? null : JSON.stringify(result),
      error,
      terminal ? null : owner,
      terminal ? null : task.leaseExpiresAt,
      now,
      terminal ? now : null,
      id,
    );
    this.db.prepare(`
      INSERT INTO automation_task_events(task_id, event_type, detail_json, created_at) VALUES (?, ?, ?, ?)
    `).run(id, target, JSON.stringify(eventDetail), now);
    return this.mustGet(id);
  }

  private mustGet(id: string, fallback?: AutomationTask): AutomationTask {
    const task = this.get(id) ?? fallback;
    if (!task) {
      throw new Error(`task ${id} disappeared`);
    }
    return task;
  }
}
