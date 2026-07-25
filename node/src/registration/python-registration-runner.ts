import type { BrowserTaskRunner } from "../automation/browser-task-runner.js";
import type { BrowserTaskRuntime } from "../automation/browser-task-runner.js";
import type { CloudflareMailboxCredentialStore, SsoRegistrationConverter } from "./cloudflare-registration-runner.js";

interface PythonRegistrationOptions {
  readonly serviceUrl: string;
  readonly token: string | null;
  readonly timeoutMs: number;
  readonly cfMailBaseUrl: string;
  readonly cfMailAdminPassword: string;
  readonly cfMailDomain: string | null;
  readonly ssoConverter: SsoRegistrationConverter;
  readonly mailboxStore: CloudflareMailboxCredentialStore;
  readonly fetchImpl?: typeof fetch;
}

export class PythonRegistrationTaskRunner implements BrowserTaskRunner {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PythonRegistrationOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async run(request: Record<string, unknown>, runtime: BrowserTaskRuntime = {}): Promise<Record<string, unknown>> {
    const registration = record(request.registration);
    const count = integer(request.count, 1, 1, 100);
    const concurrency = integer(request.concurrency, 1, 1, count);
    let sessionId = "";
    let batchId = "";
    let completed = false;
    let lastWorkerEvent = "";
    try {
      const mailbox = record(request.mailbox);
      runtime.signal?.throwIfAborted();
      runtime.onEvent?.({ type: "worker_started", message: "注册工作器已启动" });
      const started = await this.call("/internal/registration/v1/jobs", {
        captcha_provider: "local",
        local_solver_url: "http://127.0.0.1:5072",
        proxy: "",
        mail_provider: "cfmail",
        cfmail_base_url: string(registration?.mailBaseUrl) || this.options.cfMailBaseUrl,
        cfmail_api_key: string(registration?.mailApiKey) || this.options.cfMailAdminPassword,
        cfmail_domain: string(registration?.mailDomain) || string(mailbox?.domain) || this.options.cfMailDomain || "",
        count,
        concurrency,
        probe_delay_sec: 0,
      }, "POST");
      batchId = string(started.batch_id);
      sessionId = string(started.id || started.session_id);
      if (batchId) {
        return await this.runBatch(batchId, count, concurrency, runtime, () => { completed = true; });
      }
      if (!sessionId) {
        throw new Error("registration worker did not return a session id");
      }
      const deadline = Date.now() + this.options.timeoutMs;
      while (Date.now() < deadline) {
        runtime.signal?.throwIfAborted();
        const session = await this.call(`/internal/registration/v1/sessions/${encodeURIComponent(sessionId)}?include_auth_json=1`, undefined, "GET");
        const status = string(session.status).toLowerCase();
        const workerMessage = string(session.message) || `注册状态：${status || "running"}`;
        const workerEvent = `${status}\n${workerMessage}`;
        if (workerEvent !== lastWorkerEvent) {
          runtime.onEvent?.({ type: `worker_${status || "running"}`, message: workerMessage });
          lastWorkerEvent = workerEvent;
        }
        if (["completed", "success", "imported"].includes(status)) {
          const account = await this.persistSession(session);
          completed = true;
          return {
            accountId: account.accountId,
            email: account.email,
            mailProvider: "cloudflare_temp_mail",
            executor: "python_registration_worker",
            targetCount: 1,
            concurrency: 1,
            successCount: 1,
            failedCount: 0,
          };
        }
        if (["error", "failed", "expired", "protocol_error", "protocol_blocked", "cancelled", "stopped"].includes(status)) {
          throw new Error(`registration worker ended with ${status}: ${string(session.error || session.message).slice(0, 300)}`);
        }
        await abortableDelay(1_000, runtime.signal);
      }
      throw new Error("registration worker timed out");
    } finally {
      if (batchId && !completed) {
        await this.call(`/internal/registration/v1/batches/${encodeURIComponent(batchId)}/stop`, {}, "POST").catch(() => undefined);
      } else if (sessionId && !completed) {
        await this.call(`/internal/registration/v1/sessions/${encodeURIComponent(sessionId)}/stop`, {}, "POST").catch(() => undefined);
      }
    }
  }

  private async runBatch(
    batchId: string,
    targetCount: number,
    concurrency: number,
    runtime: BrowserTaskRuntime,
    markCompleted: () => void,
  ): Promise<Record<string, unknown>> {
    const imported = new Set<string>();
    const failed = new Set<string>();
    const accounts: Array<{ readonly accountId: string; readonly email: string }> = [];
    const deadline = Date.now() + this.options.timeoutMs * Math.ceil(targetCount / concurrency);
    let lastProgress = "";
    while (Date.now() < deadline) {
      runtime.signal?.throwIfAborted();
      const batch = await this.call(`/internal/registration/v1/batches/${encodeURIComponent(batchId)}`, undefined, "GET");
      const sessions = Array.isArray(batch.sessions) ? batch.sessions.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
      for (const session of sessions) {
        const id = string(session.id);
        const status = string(session.status).toLowerCase();
        if (!id || imported.has(id) || failed.has(id)) continue;
        if (["completed", "success", "imported"].includes(status)) {
          const detail = await this.call(`/internal/registration/v1/sessions/${encodeURIComponent(id)}?include_auth_json=1`, undefined, "GET");
          accounts.push(await this.persistSession(detail));
          imported.add(id);
        } else if (["error", "failed", "expired", "protocol_error", "protocol_blocked", "cancelled", "stopped"].includes(status)) {
          failed.add(id);
        }
      }
      const successCount = Math.max(imported.size, numeric(batch.imported), numeric(batch.ok_count));
      const failedCount = Math.max(failed.size, numeric(batch.error), numeric(batch.fail_count));
      const running = numeric(batch.running);
      const spawned = Math.max(numeric(batch.spawned), imported.size + failed.size + running);
      const message = string(batch.message) || `批次进度 ${successCount + failedCount}/${targetCount}`;
      const progressKey = `${successCount}:${failedCount}:${running}:${spawned}:${message}`;
      if (progressKey !== lastProgress) {
        runtime.onEvent?.({
          type: "worker_batch_progress",
          message,
          detail: { batchId, targetCount, concurrency, successCount, failedCount, running, spawned },
        });
        lastProgress = progressKey;
      }
      const status = string(batch.status || batch.batch_status).toLowerCase();
      if (["done", "partial", "error", "cancelled", "stopped"].includes(status)) {
        if (!successCount) throw new Error(`registration batch ended with ${status}: ${string(batch.error || batch.message).slice(0, 300)}`);
        markCompleted();
        return {
          batchId,
          targetCount,
          concurrency,
          successCount,
          failedCount,
          accounts,
          mailProvider: "cloudflare_temp_mail",
          executor: "python_registration_worker",
        };
      }
      await abortableDelay(1_000, runtime.signal);
    }
    throw new Error("registration batch timed out");
  }

  private async persistSession(session: Record<string, unknown>): Promise<{ readonly accountId: string; readonly email: string }> {
    const external = record(record(session.auth_json)?.external_registration);
    const sso = string(external?.sso);
    const email = string(external?.email);
    const password = string(external?.password);
    const token = record(external?.token);
    const workerMailbox = record(external?.mailbox);
    if (!sso || !email || !workerMailbox) throw new Error("registration worker completed without protocol authentication");
    const account = string(token?.access_token)
      ? await this.options.ssoConverter.registerFromSsoCookie(sso, email, token!)
      : password && this.options.ssoConverter.registerPendingAccount
        ? await this.options.ssoConverter.registerPendingAccount(sso, email, password)
        : (() => { throw new Error("registration token is pending but no lifecycle store is configured"); })();
    const mailboxId = string(workerMailbox.id);
    const mailboxAddress = string(workerMailbox.address) || email;
    const mailboxToken = string(workerMailbox.access_token);
    if (mailboxId && mailboxAddress && mailboxToken) {
      this.options.mailboxStore.saveCloudflareMailboxCredential(account.accountId, { id: mailboxId, address: mailboxAddress, accessToken: mailboxToken });
    }
    return { accountId: account.accountId, email: account.email ?? email };
  }

  private async call(path: string, body: Record<string, unknown> | undefined, method: "GET" | "POST"): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.options.serviceUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      throw new Error(`registration worker HTTP ${response.status}: ${string(record(payload)?.detail).slice(0, 300)}`);
    }
    const output = record(payload);
    if (!output) {
      throw new Error("registration worker returned invalid JSON");
    }
    return output;
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("registration cancelled"));
    }, { once: true });
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}
