import type { SsoReauthService } from "../auth/sso-reauth-service.js";
import type { AppConfig } from "../config.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import type { BrowserTaskRunner } from "./browser-task-runner.js";

export interface AutomationTaskWorkerOptions {
  readonly store: SqliteStore;
  readonly ssoReauth: Pick<SsoReauthService, "reauthenticate">;
  readonly browserRunner: BrowserTaskRunner;
  readonly registrationRunner?: BrowserTaskRunner | null;
  readonly emailLoginRunner?: BrowserTaskRunner | null;
  readonly config: Pick<AppConfig, "workerLeaseMs" | "ssoReauthCooldownMs">;
  readonly owner?: string;
  readonly kinds?: readonly string[];
}

export class AutomationTaskWorker {
  private readonly owner: string;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly options: AutomationTaskWorkerOptions) {
    this.owner = options.owner?.trim() || `node-${process.pid}`;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.runOnce(), 1_000);
    this.timer.unref();
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const controller of this.active.values()) controller.abort();
  }

  cancel(taskId: string): boolean {
    const controller = this.active.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async runOnce(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const tasks = this.options.store.automationTasks();
      const task = tasks.claimNext(this.owner, this.options.config.workerLeaseMs, Date.now(), this.options.kinds);
      if (!task) {
        return;
      }
      tasks.markRunning(task.id, this.owner);
      const heartbeat = setInterval(
        () => tasks.renewLease(task.id, this.owner, this.options.config.workerLeaseMs),
        Math.max(10, Math.min(30_000, Math.floor(this.options.config.workerLeaseMs / 3))),
      );
      heartbeat.unref();
      try {
        if (task.kind === "sso_reauth") {
          await this.runSsoReauth(task.id, task.request);
          return;
        }
        if (task.kind === "browser_automation" || task.kind === "registration" || task.kind === "sso_email_reauth") {
          const controller = new AbortController();
          this.active.set(task.id, controller);
          try {
            const runner = task.kind === "registration"
              ? this.options.registrationRunner
              : task.kind === "sso_email_reauth"
                ? this.options.emailLoginRunner
                : this.options.browserRunner;
            if (!runner) {
              throw new Error(task.kind === "sso_email_reauth"
                ? "Cloudflare Temp Mail email login is not configured"
                : "Cloudflare Temp Mail registration is not configured");
            }
            const result = await runner.run(task.request, {
              signal: controller.signal,
              onEvent: (event) => tasks.appendEvent(task.id, event.type, { ...event.detail, message: event.message }),
            });
            tasks.succeed(task.id, this.owner, result);
          } catch (error) {
            if (controller.signal.aborted) tasks.cancelRunning(task.id, this.owner);
            else {
              const reason = messageFor(error);
              if (task.kind === "sso_email_reauth") {
                const accountId = typeof task.request.accountId === "string" ? task.request.accountId : "";
                if (accountId) {
                  if (isOAuthAccessDenied(reason)) this.options.store.markSsoReauthBanned(accountId, reason);
                  else this.options.store.markSsoReauthFailure(accountId, reason, this.options.config.ssoReauthCooldownMs);
                }
              }
              tasks.fail(task.id, this.owner, reason);
            }
          } finally {
            this.active.delete(task.id);
          }
          return;
        }
        tasks.fail(task.id, this.owner, `unsupported automation task kind: ${task.kind}`);
      } finally {
        clearInterval(heartbeat);
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "automation_worker_error", owner: this.owner, error: messageFor(error) }));
    } finally {
      this.running = false;
    }
  }

  private async runSsoReauth(taskId: string, request: Record<string, unknown>): Promise<void> {
    const accountId = typeof request.accountId === "string" ? request.accountId.trim() : "";
    const tasks = this.options.store.automationTasks();
    if (!accountId) {
      tasks.fail(taskId, this.owner, "sso_reauth task is missing accountId");
      return;
    }
    try {
      const result = await this.options.ssoReauth.reauthenticate(accountId);
      tasks.succeed(taskId, this.owner, { accountId: result.accountId, recoveredBy: "sso" });
    } catch (error) {
      const reason = messageFor(error);
      this.options.store.markSsoReauthFailure(accountId, reason, this.options.config.ssoReauthCooldownMs);
      const queued = tasks.enqueue("sso_email_reauth", `sso_email_reauth:auto:${accountId}:${Date.now()}`, {
        accountId,
        trigger: "saved_sso_invalid",
        browser: { url: "https://accounts.x.ai/sign-in", actions: [{ type: "xai_email_login" }] },
      });
      tasks.succeed(taskId, this.owner, { accountId, recoveredBy: "email_queued", queuedTaskId: queued.id, savedSsoError: reason });
    }
  }
}

export class AutomationTaskWorkerPool {
  constructor(private readonly workers: readonly AutomationTaskWorker[]) {}

  start(): void { for (const worker of this.workers) worker.start(); }
  stop(): void { for (const worker of this.workers) worker.stop(); }
  cancel(taskId: string): boolean { return this.workers.some((worker) => worker.cancel(taskId)); }
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 400) : "automation task failed";
}

function isOAuthAccessDenied(reason: string): boolean {
  return /invalid_grant\s*:\s*access denied/i.test(reason);
}
