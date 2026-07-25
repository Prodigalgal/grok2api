import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { issueApiKey } from "../auth/api-key-manager.js";
import { requireApiKey, type ApiKeyAuthConfig, type ApiKeyStore } from "../auth/api-key-auth.js";
import type { ChatService } from "../chat/service.js";
import type { AutomationTaskRepository, AutomationTask } from "../automation/task-repository.js";
import type { AutomationTaskWorker } from "../automation/task-worker.js";
import { openAiModelList, type ModelStore } from "../models/catalog.js";
import { buildResponseObject, ResponsesLiveEncoder, responsesToChatBody } from "../protocol/openai-responses.js";
import { UpstreamError } from "../upstream/responses-client.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import type { TokenMaintainer } from "../maintainer/service.js";

export interface HealthServer {
  listen(host: string, port: number): Promise<number>;
  close(): Promise<void>;
}

export interface ApiServerOptions {
  readonly modelStore?: ModelStore | null;
  readonly apiKeyStore?: ApiKeyStore | null;
  readonly defaultModel?: string;
  readonly apiKeyAuth?: ApiKeyAuthConfig;
  readonly chatService?: ChatService | null;
  readonly automationTasks?: AutomationTaskRepository | null;
  readonly automationWorker?: Pick<AutomationTaskWorker, "cancel"> | null;
  readonly registrationAvailable?: boolean;
  readonly registrationDefaults?: {
    readonly mailBaseUrl: string | null;
    readonly mailDomain: string | null;
    readonly maxConcurrency?: number;
  };
  readonly reauthConcurrency?: number;
  readonly adminStore?: SqliteStore | null;
  readonly adminUsername?: string | null;
  readonly adminPassword?: string | null;
  readonly maintainer?: Pick<TokenMaintainer, "runOnce"> | null;
}

function statusFor(error: unknown): number {
  return error instanceof UpstreamError && error.status >= 400 && error.status <= 599 ? error.status : 502;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "upstream request failed";
}

function responseFailureFor(error: unknown): { readonly code: string; readonly message: string } {
  if (!(error instanceof UpstreamError)) {
    return { code: "server_error", message: messageFor(error) };
  }
  let code = error.status >= 500 ? "upstream_error" : "invalid_request_error";
  let message = messageFor(error);
  try {
    const parsed = JSON.parse(error.body) as Record<string, unknown>;
    if (typeof parsed.code === "string" && parsed.code.trim()) {
      code = parsed.code.trim();
    }
    const nested = parsed.error && !Array.isArray(parsed.error) && typeof parsed.error === "object"
      ? parsed.error as Record<string, unknown>
      : null;
    const detail = typeof parsed.error === "string" ? parsed.error
      : typeof parsed.message === "string" ? parsed.message
      : typeof nested?.message === "string" ? nested.message
      : "";
    if (detail.trim()) {
      message = detail.trim();
    }
  } catch {
    // Preserve the upstream status context when its body is not JSON.
  }
  return { code, message };
}

function requestBody(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (!body || Array.isArray(body) || typeof body !== "object") {
    throw new Error("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key].trim() : "";
}

function withGrokConversationHint(request: FastifyRequest, body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()) {
    return body;
  }
  for (const name of ["x-grok-conv-id", "x-grok-session-id"] as const) {
    const raw = request.headers[name];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value) {
      return { ...body, prompt_cache_key: value };
    }
  }
  return body;
}

function beginSse(reply: FastifyReply): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

function writeSse(reply: FastifyReply, data: string): void {
  reply.raw.write(data);
}

function sameSecret(candidate: string, expected: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

function hasAdminAccess(request: FastifyRequest, username: string | null, password: string | null): boolean {
  if (!password) {
    return false;
  }
  const raw = request.headers["x-admin-password"];
  const supplied = Array.isArray(raw) ? raw[0] : raw;
  const candidate = typeof supplied === "string" ? supplied : "";
  const rawUsername = request.headers["x-admin-username"];
  const suppliedUsername = Array.isArray(rawUsername) ? rawUsername[0] : rawUsername;
  return sameSecret(candidate, password)
    && (!username || sameSecret(typeof suppliedUsername === "string" ? suppliedUsername : "", username));
}

function publicTask(task: AutomationTask): Record<string, unknown> {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    attempts: task.attempts,
    result: task.result,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
    ...(task.kind === "registration" ? {
      batch: {
        count: typeof task.request.count === "number" ? task.request.count : 1,
        concurrency: typeof task.request.concurrency === "number" ? task.request.concurrency : 1,
      },
    } : {}),
  };
}

function adminAsset(name: "index.html" | "app.css" | "app.js"): string {
  return readFileSync(resolve(process.cwd(), "public", "admin", name), "utf8");
}

export function createApiServer(options: ApiServerOptions = {}): HealthServer {
  const modelStore = options.modelStore ?? null;
  const apiKeyStore = options.apiKeyStore ?? null;
  let defaultModel = options.defaultModel?.trim() || "grok-4.5";
  const apiKeyAuth: ApiKeyAuthConfig = options.apiKeyAuth ?? { legacyApiKey: null, requireApiKey: "auto" };
  const chatService = options.chatService ?? null;
  const automationTasks = options.automationTasks ?? null;
  const automationWorker = options.automationWorker ?? null;
  const registrationAvailable = options.registrationAvailable ?? true;
  const adminStore = options.adminStore ?? null;
  const adminUsername = options.adminUsername?.trim() || null;
  const adminPassword = options.adminPassword?.trim() || null;
  const maintainer = options.maintainer ?? null;
  const app = Fastify({
    bodyLimit: 8 * 1024 * 1024,
    logger: false,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (reply.sent) {
      return;
    }
    reply.code(500).header("cache-control", "no-store").send({ detail: messageFor(error) });
  });

  app.get("/live", async (_request, reply) => reply.header("cache-control", "no-store").send({ ok: true, service: "grok2api" }));
  const readiness = async (_request: FastifyRequest, reply: FastifyReply) => {
    const upstreamConfigured = chatService === null || chatService.isUpstreamConfigured();
    return reply.code(upstreamConfigured ? 200 : 503).header("cache-control", "no-store").send({
      ok: upstreamConfigured,
      ready: upstreamConfigured,
      service: "grok2api",
      store: "sqlite",
      ...(upstreamConfigured ? {} : { detail: "direct xAI upstream is not configured" }),
    });
  };
  app.get("/ready", readiness);
  app.get("/health", readiness);
  app.get("/metrics", async (_request, reply) => {
    const pool = adminStore?.poolSummary();
    const usage = adminStore?.usageSummary().total;
    const lines = [
      "# TYPE grok2api_accounts gauge",
      `grok2api_accounts ${pool?.total ?? 0}`,
      "# TYPE grok2api_accounts_live gauge",
      `grok2api_accounts_live ${pool?.live ?? 0}`,
      "# TYPE grok2api_requests_total counter",
      `grok2api_requests_total ${usage?.requests ?? 0}`,
      "# TYPE grok2api_tokens_total counter",
      `grok2api_tokens_total ${usage?.totalTokens ?? 0}`,
    ];
    return reply.type("text/plain; version=0.0.4; charset=utf-8").header("cache-control", "no-store").send(`${lines.join("\n")}\n`);
  });

  app.get("/", async (_request, reply) => reply.redirect("/admin"));
  for (const path of ["/admin", "/admin/", "/admin/accounts", "/admin/keys", "/admin/models", "/admin/tasks", "/admin/keepalive", "/admin/usage", "/admin/logs", "/admin/settings"]) {
    app.get(path, async (_request, reply) => reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(adminAsset("index.html")));
  }
  app.get("/admin/app.css", async (_request, reply) => reply.type("text/css; charset=utf-8").header("cache-control", "public, max-age=300").send(adminAsset("app.css")));
  app.get("/admin/app.js", async (_request, reply) => reply.type("text/javascript; charset=utf-8").header("cache-control", "public, max-age=300").send(adminAsset("app.js")));

  const requireAdmin = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!adminPassword) {
      reply.code(503).header("cache-control", "no-store").send({ detail: "admin API is disabled" });
      return false;
    }
    if (!hasAdminAccess(request, adminUsername, adminPassword)) {
      reply.code(401).header("cache-control", "no-store").send({ detail: "invalid admin credentials" });
      return false;
    }
    return true;
  };

  const requireAdminStore = (request: FastifyRequest, reply: FastifyReply): SqliteStore | null => {
    if (!requireAdmin(request, reply)) {
      return null;
    }
    if (!adminStore) {
      reply.code(503).header("cache-control", "no-store").send({ detail: "SQLite admin store is unavailable" });
      return null;
    }
    return adminStore;
  };

  app.get("/admin/api/status", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const keys = store.listApiKeySummaries();
    const pool = store.poolSummary();
    return reply.header("cache-control", "no-store").send({
      ok: true,
      store: { backend: "sqlite", redis: false, postgresql: false },
      accounts: { account_count: store.countAccounts(), active_count: pool.live },
      pool,
      models_count: store.countModels(),
      keys: {
        total: keys.length,
        enabled: keys.filter((key) => key.enabled).length,
        disabled: keys.filter((key) => !key.enabled).length,
        total_requests: keys.reduce((total, key) => total + key.requestCount, 0),
      },
      direct_xai: { configured: chatService?.isUpstreamConfigured() ?? false },
      registration: { provider: "cloudflare_temp_mail", available: registrationAvailable },
      usage: store.usageSummary(),
    });
  });

  app.get("/admin/api/models", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    return reply.header("cache-control", "no-store").send({
      ...openAiModelList(store, defaultModel),
      default_model: defaultModel,
      storage: "sqlite",
    });
  });

  app.get("/admin/api/usage/summary", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    return reply.header("cache-control", "no-store").send({ ok: true, ...store.usageSummary(), storage: "sqlite" });
  });

  app.post("/admin/api/models/save", async (request, reply) => {
    const store = requireAdminStore(request, reply); if (!store) return reply;
    const body = requestBody(request);
    const values = Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : [];
    const models = values.flatMap((value, index) => {
      if (!value || Array.isArray(value) || typeof value !== "object") return [];
      const model = value as Record<string, unknown>;
      const id = stringField(model, "id");
      if (!id) return [];
      return [{ id, name: stringField(model, "name") || null, description: stringField(model, "description") || null, ownedBy: stringField(model, "owned_by") || "xai", hidden: model.hidden === true, contextWindow: typeof model.context_window === "number" ? model.context_window : null, supportsReasoningEffort: typeof model.supports_reasoning_effort === "boolean" ? model.supports_reasoning_effort : null, extra: model, sortOrder: index }];
    });
    return reply.header("cache-control", "no-store").send({ ok: true, saved: store.replaceModels(models), data: openAiModelList(store, defaultModel).data });
  });
  for (const path of ["/admin/api/models/sync", "/admin/api/models/fetch"]) {
    app.post(path, async (request, reply) => {
      const store = requireAdminStore(request, reply); if (!store) return reply;
      const current = openAiModelList(store, defaultModel);
      return reply.header("cache-control", "no-store").send({ ok: true, synced: store.countModels(), data: current.data, source: "sqlite" });
    });
  }
  app.get("/admin/api/model-health", async (request, reply) => {
    const store = requireAdminStore(request, reply); if (!store) return reply;
    return reply.header("cache-control", "no-store").send({ ok: true, enabled: true, pool: store.poolSummary(), models: store.listPublicModels(), job: null });
  });
  app.get("/admin/api/upstream-status", async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const configured = chatService?.isUpstreamConfigured() ?? false;
    return reply.code(configured ? 200 : 503).header("cache-control", "no-store").send({ ok: configured, reachable: configured, configured, detail: configured ? "upstream configured" : "direct xAI upstream is not configured" });
  });

  app.get("/admin/api/dashboard", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) return reply;
    const keys = store.listApiKeySummaries();
    const pool = store.poolSummary();
    return reply.header("cache-control", "no-store").send({
      ok: true,
      accounts: { account_count: store.countAccounts(), active_count: pool.live },
      pool,
      models_count: store.countModels(),
      keys: { total: keys.length, enabled: keys.filter((key) => key.enabled).length },
      usage: store.usageSummary(),
      store: { backend: "sqlite", redis: false, postgresql: false },
    });
  });

  app.get("/admin/api/usage/series", async (request, reply) => {
    const store = requireAdminStore(request, reply); if (!store) return reply;
    const raw = (request.query as { days?: unknown }).days;
    const days = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : 14;
    return reply.header("cache-control", "no-store").send({ ok: true, series: store.usageSeries(days) });
  });
  for (const [path, dimension] of [["/admin/api/usage/by-key", "api_key_id"], ["/admin/api/usage/by-account", "account_id"], ["/admin/api/usage/by-model", "model"]] as const) {
    app.get(path, async (request, reply) => {
      const store = requireAdminStore(request, reply); if (!store) return reply;
      return reply.header("cache-control", "no-store").send({ ok: true, items: store.usageBreakdown(dimension) });
    });
  }
  app.get("/admin/api/usage/events", async (request, reply) => {
    const store = requireAdminStore(request, reply); if (!store) return reply;
    const raw = (request.query as { limit?: unknown }).limit;
    const limit = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : 100;
    return reply.header("cache-control", "no-store").send({ ok: true, events: store.usageEvents(limit) });
  });

  app.get("/admin/api/settings", async (request, reply) => {
    const store = requireAdminStore(request, reply); if (!store) return reply;
    return reply.header("cache-control", "no-store").send({ ok: true, settings: store.listSettings(), runtime: { default_model: defaultModel } });
  });
  for (const method of ["put", "patch"] as const) {
    app[method]("/admin/api/settings", async (request, reply) => {
      const store = requireAdminStore(request, reply); if (!store) return reply;
      const body = requestBody(request);
      const settings = body.settings && !Array.isArray(body.settings) && typeof body.settings === "object" ? body.settings as Record<string, unknown> : body;
      const forbidden = Object.keys(settings).find((key) => /sub2api|cliproxy|cpa/i.test(key));
      if (forbidden) return reply.code(400).header("cache-control", "no-store").send({ detail: `removed integration setting is not supported: ${forbidden}` });
      const nextDefault = settings.default_model === undefined ? undefined : typeof settings.default_model === "string" && settings.default_model.trim() ? settings.default_model.trim() : null;
      const nextMode = settings.account_mode === undefined ? undefined : typeof settings.account_mode === "string" && ["round_robin", "least_used", "random"].includes(settings.account_mode) ? settings.account_mode as "round_robin" | "least_used" | "random" : null;
      if (nextDefault === null || nextMode === null) return reply.code(400).header("cache-control", "no-store").send({ detail: "default_model or account_mode is invalid" });
      if (nextDefault) defaultModel = nextDefault;
      chatService?.updateRuntime({ ...(nextDefault ? { defaultModel: nextDefault } : {}), ...(nextMode ? { poolMode: nextMode } : {}) });
      return reply.header("cache-control", "no-store").send({ ok: true, updated: store.updateSettings(settings), settings: store.listSettings() });
    });
  }
  app.get("/admin/api/logs", async (request, reply) => {
    const store = requireAdminStore(request, reply); if (!store) return reply;
    const raw = (request.query as { limit?: unknown }).limit;
    const limit = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : 100;
    return reply.header("cache-control", "no-store").send({ ok: true, logs: store.listOperationalLogs(limit) });
  });
  app.get("/admin/api/logs/actions", async (request, reply) => {
    const store = requireAdminStore(request, reply); if (!store) return reply;
    const actions = [...new Set(store.listOperationalLogs(500).map((entry) => entry.type))].sort();
    return reply.header("cache-control", "no-store").send({ ok: true, actions });
  });

  app.get("/admin/api/accounts", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const query = request.query as { q?: unknown; status?: unknown; sort?: unknown; page?: unknown; page_size?: unknown };
    const status = typeof query.status === "string" && query.status.trim() ? query.status.trim() : undefined;
    if (status !== undefined && !["active", "disabled", "quota_disabled", "cooldown", "expired", "banned"].includes(status)) {
      return reply.code(400).header("cache-control", "no-store").send({ detail: "unsupported account status filter" });
    }
    const sort = typeof query.sort === "string" && query.sort.trim() ? query.sort.trim() : undefined;
    if (sort !== undefined && !["id", "email", "expires_at", "last_used_at", "request_count"].includes(sort)) {
      return reply.code(400).header("cache-control", "no-store").send({ detail: "unsupported account sort" });
    }
    const numberQuery = (value: unknown): number | undefined => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined;
    const page = numberQuery(query.page);
    const pageSize = numberQuery(query.page_size);
    const result = store.listAccountSummaries({
      ...(typeof query.q === "string" && query.q.trim() ? { query: query.q } : {}),
      ...(status ? { status: status as "active" | "disabled" | "quota_disabled" | "cooldown" | "expired" | "banned" } : {}),
      ...(sort ? { sort: sort as "id" | "email" | "expires_at" | "last_used_at" | "request_count" } : {}),
      ...(page ? { page } : {}),
      ...(pageSize ? { pageSize } : {}),
    });
    return reply.header("cache-control", "no-store").send({ ...result, pool: store.poolSummary(), store_source: "sqlite" });
  });

  app.patch("/admin/api/accounts/:id/enabled", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const enabled = requestBody(request).enabled;
    if (typeof enabled !== "boolean") {
      return reply.code(400).header("cache-control", "no-store").send({ detail: "enabled must be a boolean" });
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    if (!store.getAccountSummary(id)) {
      return reply.code(404).header("cache-control", "no-store").send({ detail: "account was not found" });
    }
    store.updatePoolEligibility(id, { enabled });
    return reply.header("cache-control", "no-store").send({ ok: true, account: store.getAccountSummary(id) });
  });

  app.post("/admin/api/accounts/:id/cooldown/clear", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    if (!store.getAccountSummary(id)) {
      return reply.code(404).header("cache-control", "no-store").send({ detail: "account was not found" });
    }
    store.updatePoolEligibility(id, { cooldownUntil: null });
    return reply.header("cache-control", "no-store").send({ ok: true, account: store.getAccountSummary(id) });
  });

  const deleteAdminAccount = (store: SqliteStore, id: string, reply: FastifyReply) => {
    if (!id || !store.getAccountSummary(id)) {
      return reply.code(404).header("cache-control", "no-store").send({ detail: "account was not found" });
    }
    const tasks = store.automationTasks();
    const cancelledTasks = tasks.cancelPendingForAccount(id);
    const blockingTasks = tasks.listActiveForAccount(id);
    if (blockingTasks.length > 0) {
      return reply.code(409).header("cache-control", "no-store").send({
        detail: "account has a running keepalive task; retry deletion after it finishes",
        active_tasks: blockingTasks.map((task) => ({ id: task.id, status: task.status })),
      });
    }
    return store.deleteAccount(id)
      ? reply.header("cache-control", "no-store").send({ ok: true, account_id: id, cancelled_tasks: cancelledTasks })
      : reply.code(404).header("cache-control", "no-store").send({ detail: "account was not found" });
  };

  app.delete("/admin/api/accounts/:id", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) return reply;
    return deleteAdminAccount(store, (request.params as { id?: string }).id?.trim() || "", reply);
  });

  app.post("/admin/api/accounts/delete", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) return reply;
    return deleteAdminAccount(store, stringField(requestBody(request), "id"), reply);
  });

  app.get("/admin/api/keys", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const keys = store.listApiKeySummaries();
    return reply.header("cache-control", "no-store").send({
      keys,
      stats: { total: keys.length, enabled: keys.filter((key) => key.enabled).length, disabled: keys.filter((key) => !key.enabled).length },
      store_source: "sqlite",
    });
  });

  app.post("/admin/api/keys", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const body = requestBody(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (!name || name.length > 120 || note.length > 1_000) {
      return reply.code(400).header("cache-control", "no-store").send({ detail: "name is required and note is limited to 1000 characters" });
    }
    const issued = issueApiKey();
    const key = store.createApiKey({ id: issued.id, name, note, prefix: issued.prefix, keyHash: issued.keyHash, secret: issued.secret });
    return reply.code(201).header("cache-control", "no-store").send({ ok: true, key, secret: issued.secret });
  });

  app.patch("/admin/api/keys/:id", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const body = requestBody(request);
    const name = body.name === undefined ? undefined : typeof body.name === "string" ? body.name : null;
    const note = body.note === undefined ? undefined : typeof body.note === "string" ? body.note : null;
    const enabled = body.enabled === undefined ? undefined : typeof body.enabled === "boolean" ? body.enabled : null;
    if (name === null || note === null || enabled === null || (name === undefined && note === undefined && enabled === undefined)) {
      return reply.code(400).header("cache-control", "no-store").send({ detail: "name, note, or enabled must be supplied with valid types" });
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    try {
      const key = store.updateApiKey(id, { ...(name === undefined ? {} : { name }), ...(note === undefined ? {} : { note }), ...(enabled === undefined ? {} : { enabled }) });
      return reply.header("cache-control", "no-store").send({ ok: true, key });
    } catch (error) {
      return reply.code(messageFor(error).includes("not found") ? 404 : 400).header("cache-control", "no-store").send({ detail: messageFor(error) });
    }
  });

  app.post("/admin/api/keys/:id/regenerate", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    const issued = issueApiKey();
    try {
      const key = store.rotateApiKey(id, issued.prefix, issued.keyHash, issued.secret);
      return reply.header("cache-control", "no-store").send({ ok: true, key, secret: issued.secret });
    } catch (error) {
      return reply.code(404).header("cache-control", "no-store").send({ detail: messageFor(error) });
    }
  });

  app.delete("/admin/api/keys/:id", async (request, reply) => {
    const store = requireAdminStore(request, reply);
    if (!store) {
      return reply;
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    return store.deleteApiKey(id)
      ? reply.header("cache-control", "no-store").send({ ok: true, key_id: id })
      : reply.code(404).header("cache-control", "no-store").send({ detail: "API key was not found" });
  });

  app.post("/admin/api/accounts/register", async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    if (!automationTasks || !registrationAvailable) {
      return reply.code(503).header("cache-control", "no-store").send({ detail: "registration worker is unavailable" });
    }
    const body = requestBody(request);
    const count = typeof body.count === "number" && Number.isInteger(body.count) ? body.count : 1;
    if (count < 1 || count > 100) {
      return reply.code(400).header("cache-control", "no-store").send({ detail: "registration count must be between 1 and 100" });
    }
    const maxConcurrency = Math.max(1, options.registrationDefaults?.maxConcurrency ?? 1);
    const concurrency = typeof body.concurrency === "number" && Number.isInteger(body.concurrency) ? body.concurrency : 1;
    if (concurrency < 1 || concurrency > maxConcurrency || concurrency > count) {
      return reply.code(400).header("cache-control", "no-store").send({ detail: `registration concurrency must be between 1 and ${Math.min(maxConcurrency, count)}` });
    }
    const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
    const registration = {
      mailBaseUrl: text(body.mail_base_url),
      mailApiKey: text(body.mail_api_key),
      mailDomain: text(body.mail_domain),
    };
    for (const [name, value] of [["mail base URL", registration.mailBaseUrl]] as const) {
      if (value && !value.startsWith("https://")) {
        return reply.code(400).header("cache-control", "no-store").send({ detail: `${name} must use https` });
      }
    }
    const baseKey = text(body.idempotency_key) || `registration:${randomUUID()}`;
    const task = automationTasks.enqueue("registration", baseKey, {
      browser: {},
      count,
      concurrency,
      registration,
      mailbox: registration.mailDomain ? { domain: registration.mailDomain } : {},
    });
    return reply.code(202).header("cache-control", "no-store").send({ ok: true, tasks: [publicTask(task)], count, concurrency });
  });

  for (const method of ["patch", "post"] as const) {
    app[method]("/admin/api/accounts/:id/status", async (request, reply) => {
      const store = requireAdminStore(request, reply); if (!store) return reply;
      const id = (request.params as { id?: string }).id?.trim() || "";
      if (!store.getAccountSummary(id)) return reply.code(404).send({ detail: "account was not found" });
      const body = requestBody(request);
      const status = typeof body.status === "string" ? body.status.trim() : "";
      if (!["active", "disabled", "normal"].includes(status)) return reply.code(400).send({ detail: "status must be active or disabled" });
      store.updatePoolEligibility(id, { enabled: status !== "disabled", ...(status === "disabled" ? {} : { cooldownUntil: null }) });
      return reply.header("cache-control", "no-store").send({ ok: true, account: store.getAccountSummary(id) });
    });
  }
  app.post("/admin/api/accounts/:id/kick", async (request, reply) => {
    const store = requireAdminStore(request, reply); if (!store) return reply;
    const id = (request.params as { id?: string }).id?.trim() || "";
    if (!store.getAccountSummary(id)) return reply.code(404).send({ detail: "account was not found" });
    store.updatePoolEligibility(id, { enabled: false });
    return reply.header("cache-control", "no-store").send({ ok: true, account: store.getAccountSummary(id) });
  });
  app.get("/admin/api/accounts/export", async (request, reply) => {
    const store = requireAdminStore(request, reply); if (!store) return reply;
    return reply.header("content-disposition", "attachment; filename=auth.json").header("cache-control", "no-store").send({ source: "grok2api-node", exported_at: Date.now(), auth: store.exportAccounts() });
  });
  app.post("/admin/api/accounts/import", async (request, reply) => {
    const store = requireAdminStore(request, reply); if (!store) return reply;
    const body = requestBody(request);
    const rawAuth = body.auth && !Array.isArray(body.auth) && typeof body.auth === "object" ? body.auth as Record<string, unknown> : body;
    let imported = 0;
    for (const [fallbackId, raw] of Object.entries(rawAuth)) {
      if (!raw || Array.isArray(raw) || typeof raw !== "object") continue;
      const payload = raw as Record<string, unknown>;
      const id = stringField(payload, "id") || stringField(payload, "user_id") || stringField(payload, "principal_id") || fallbackId;
      if (!id.trim()) continue;
      const expiresRaw = payload.expires_at;
      const expiresAt = typeof expiresRaw === "number" && Number.isFinite(expiresRaw) ? Math.trunc(expiresRaw < 10_000_000_000 ? expiresRaw * 1000 : expiresRaw) : null;
      store.saveAccount({ id, email: stringField(payload, "email") || null, userId: stringField(payload, "user_id") || stringField(payload, "principal_id") || null, teamId: stringField(payload, "team_id") || null, payload, expiresAt });
      imported++;
    }
    return reply.header("cache-control", "no-store").send({ ok: true, imported, total: store.countAccounts() });
  });

  app.post("/admin/api/accounts/:id/probe", async (request, reply) => {
    const store = requireAdminStore(request, reply); if (!store) return reply;
    if (!chatService) return reply.code(503).send({ detail: "chat service unavailable" });
    const id = (request.params as { id?: string }).id?.trim() || "";
    if (!store.getAccountSummary(id)) return reply.code(404).send({ detail: "account was not found" });
    const body = requestBody(request);
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : defaultModel;
    try {
      return reply.header("cache-control", "no-store").send(await chatService.probeAccount(id, model));
    } catch (error) {
      return reply.code(statusFor(error)).header("cache-control", "no-store").send({ ok: false, account_id: id, error: messageFor(error) });
    }
  });
  app.post("/admin/api/accounts/probe", async (request, reply) => {
    const store = requireAdminStore(request, reply); if (!store) return reply;
    if (!chatService) return reply.code(503).send({ detail: "chat service unavailable" });
    const body = requestBody(request);
    const id = stringField(body, "id");
    if (!id || !store.getAccountSummary(id)) return reply.code(404).send({ detail: "account was not found" });
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : defaultModel;
    try {
      return reply.header("cache-control", "no-store").send(await chatService.probeAccount(id, model));
    } catch (error) {
      return reply.code(statusFor(error)).header("cache-control", "no-store").send({ ok: false, account_id: id, error: messageFor(error) });
    }
  });
  app.post("/admin/api/accounts/probe-batch", async (request, reply) => {
    const store = requireAdminStore(request, reply); if (!store) return reply;
    if (!chatService) return reply.code(503).send({ detail: "chat service unavailable" });
    const body = requestBody(request);
    const ids = Array.isArray(body.ids) ? body.ids.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim()) : [];
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : defaultModel;
    const results = [];
    for (const id of ids.slice(0, 100)) {
      try { results.push(await chatService.probeAccount(id, model)); }
      catch (error) { results.push({ ok: false, accountId: id, model, error: messageFor(error) }); }
    }
    return reply.header("cache-control", "no-store").send({ ok: results.every((result) => result.ok), results, total: results.length });
  });
  app.post("/admin/api/accounts/probe-all", async (request, reply) => {
    const store = requireAdminStore(request, reply); if (!store) return reply;
    if (!chatService) return reply.code(503).send({ detail: "chat service unavailable" });
    const ids = store.listAccountSummaries({ page: 1, pageSize: 500 }).accounts.filter((account) => account.enabled).map((account) => account.id);
    const results = [];
    for (const id of ids) {
      try { results.push(await chatService.probeAccount(id, defaultModel)); }
      catch (error) { results.push({ ok: false, accountId: id, model: defaultModel, error: messageFor(error) }); }
    }
    return reply.header("cache-control", "no-store").send({ ok: results.every((result) => result.ok), results, total: results.length, done: true });
  });

  app.get("/admin/api/maintainer", async (request, reply) => {
    const store = requireAdminStore(request, reply); if (!store) return reply;
    const tasks = automationTasks?.list({ limit: 500 }) ?? [];
    const reauth = tasks.filter((task) => task.kind === "sso_reauth" || task.kind === "sso_email_reauth");
    const recentCutoff = Date.now() - 86_400_000;
    const recentFinalFailures = reauth.filter((task) => task.kind === "sso_email_reauth" && task.status === "failed" && task.updatedAt >= recentCutoff);
    const failureCounts = new Map<string, number>();
    for (const task of recentFinalFailures) {
      const reason = task.error || "unknown reauthorization failure";
      failureCounts.set(reason, (failureCounts.get(reason) ?? 0) + 1);
    }
    return reply.header("cache-control", "no-store").send({
      ok: true, available: maintainer !== null, pool: store.poolSummary(),
      reauth: {
        queued: reauth.filter((task) => task.status === "queued").length,
        running: reauth.filter((task) => task.status === "running" || task.status === "leased").length,
        failed24h: recentFinalFailures.length,
        workers: Math.max(1, options.reauthConcurrency ?? 1),
        failures: [...failureCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => ({ reason, count })),
      },
    });
  });
  app.post("/admin/api/accounts/enable-all", async (request, reply) => {
    const store = requireAdminStore(request, reply); if (!store) return reply;
    const result = store.enableAllRecoverableAccounts();
    let cancelledLegacyTasks = 0;
    if (automationTasks) {
      for (const task of automationTasks.listByStatus("waiting_input")) {
        automationTasks.cancelPending(task.id);
        cancelledLegacyTasks += 1;
      }
    }
    let queued = 0;
    if (automationTasks) {
      const generation = Date.now();
      for (const accountId of store.listAccountsNeedingReauth(20)) {
        automationTasks.enqueue("sso_reauth", `sso_reauth:bulk:${generation}:${accountId}`, { accountId, trigger: "bulk_keepalive" });
        queued += 1;
      }
    }
    return reply.header("cache-control", "no-store").send({ ok: true, ...result, queued, cancelledLegacyTasks });
  });
  for (const path of ["/admin/api/maintainer/run", "/admin/api/accounts/refresh"]) {
    app.post(path, async (request, reply) => {
      if (!requireAdmin(request, reply)) return reply;
      if (!maintainer) return reply.code(503).send({ detail: "token maintainer is unavailable" });
      return reply.header("cache-control", "no-store").send({ ok: true, result: await maintainer.runOnce(true) });
    });
  }
  app.get("/admin/api/accounts/register/availability", async (request, reply) => {
    if (!requireAdmin(request, reply)) {
      return reply;
    }
    return reply.header("cache-control", "no-store").send({
      ok: registrationAvailable,
      provider: "cloudflare_temp_mail",
      defaults: {
        mail_base_url: options.registrationDefaults?.mailBaseUrl ?? null,
        mail_domain: options.registrationDefaults?.mailDomain ?? null,
        mail_configured: Boolean(options.registrationDefaults?.mailBaseUrl),
        max_concurrency: Math.max(1, options.registrationDefaults?.maxConcurrency ?? 1),
      },
      ...(registrationAvailable ? {} : { detail: "registration mail is not configured" }),
    });
  });
  app.get("/admin/api/automation/tasks", async (request, reply) => {
    if (!requireAdmin(request, reply)) {
      return reply;
    }
    if (!automationTasks) {
      return reply.code(503).header("cache-control", "no-store").send({ detail: "automation tasks are unavailable" });
    }
    const query = request.query as { status?: unknown; limit?: unknown };
    const status = typeof query.status === "string" && ["queued", "leased", "running", "waiting_input", "succeeded", "failed", "cancelled"].includes(query.status)
      ? query.status as AutomationTask["status"]
      : undefined;
    const requestedLimit = typeof query.limit === "string" && /^\d+$/.test(query.limit) ? Number(query.limit) : undefined;
    const tasks = automationTasks.list({ ...(status ? { status } : {}), ...(requestedLimit ? { limit: requestedLimit } : {}) });
    return reply.header("cache-control", "no-store").send({ ok: true, tasks: tasks.map(publicTask), count: tasks.length });
  });
  app.get("/admin/api/automation/tasks/:id", async (request, reply) => {
    if (!requireAdmin(request, reply)) {
      return reply;
    }
    if (!automationTasks) {
      return reply.code(503).header("cache-control", "no-store").send({ detail: "automation tasks are unavailable" });
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    const task = automationTasks.get(id);
    return task
      ? reply.header("cache-control", "no-store").send({ ok: true, task: publicTask(task), events: automationTasks.events(id) })
      : reply.code(404).header("cache-control", "no-store").send({ detail: "automation task was not found" });
  });
  app.post("/admin/api/automation/tasks/:id/cancel", async (request, reply) => {
    if (!requireAdmin(request, reply)) {
      return reply;
    }
    if (!automationTasks) {
      return reply.code(503).header("cache-control", "no-store").send({ detail: "automation tasks are unavailable" });
    }
    const id = (request.params as { id?: string }).id?.trim() || "";
    const task = automationTasks.get(id);
    if (!task) {
      return reply.code(404).header("cache-control", "no-store").send({ detail: "automation task was not found" });
    }
    if (task.status === "running") {
      if (!automationWorker?.cancel(id)) {
        return reply.code(409).header("cache-control", "no-store").send({ detail: "running task is no longer owned by this worker" });
      }
      return reply.code(202).header("cache-control", "no-store").send({ ok: true, stopping: true, task: publicTask(task) });
    }
    if (task.status !== "queued" && task.status !== "waiting_input") {
      return reply.code(409).header("cache-control", "no-store").send({ detail: `automation task cannot be cancelled while ${task.status}` });
    }
    return reply.header("cache-control", "no-store").send({ ok: true, task: publicTask(automationTasks.cancelPending(id)) });
  });

  for (const path of ["/v1/models", "/models"]) {
    app.get(path, async (request, reply) => {
      const auth = requireApiKey(request.headers, apiKeyAuth, apiKeyStore);
      if (!auth.ok) {
        return reply.code(401).header("cache-control", "no-store").send({ detail: auth.detail });
      }
      return reply.header("cache-control", "no-store").send(openAiModelList(modelStore, defaultModel));
    });
  }

  for (const path of ["/v1/chat/completions", "/chat/completions"]) {
    app.post(path, async (request, reply) => {
      const auth = requireApiKey(request.headers, apiKeyAuth, apiKeyStore);
      if (!auth.ok) {
        return reply.code(401).header("cache-control", "no-store").send({ detail: auth.detail });
      }
      if (!chatService) {
        return reply.code(503).header("cache-control", "no-store").send({ detail: "chat service unavailable" });
      }
      try {
        const body = withGrokConversationHint(request, requestBody(request));
        if (body.stream === true) {
          beginSse(reply);
          try {
            for await (const frame of chatService.stream(body, { requestId: randomUUID(), apiKeyId: auth.apiKeyId, protocol: "chat_completions" })) {
              writeSse(reply, frame.done ? "data: [DONE]\n\n" : `data: ${frame.data}\n\n`);
            }
          } finally {
            reply.raw.end();
          }
          return reply;
        }
        return reply.header("cache-control", "no-store").send((await chatService.complete(body, {
          requestId: randomUUID(), apiKeyId: auth.apiKeyId, protocol: "chat_completions",
        })).payload);
      } catch (error) {
        return reply.code(statusFor(error)).header("cache-control", "no-store").send({ detail: messageFor(error) });
      }
    });
  }

  for (const path of ["/v1/responses", "/responses"]) {
    app.post(path, async (request, reply) => {
      const auth = requireApiKey(request.headers, apiKeyAuth, apiKeyStore);
      if (!auth.ok) {
        return reply.code(401).header("cache-control", "no-store").send({ detail: auth.detail });
      }
      if (!chatService) {
        return reply.code(503).header("cache-control", "no-store").send({ detail: "chat service unavailable" });
      }
      try {
        const raw = withGrokConversationHint(request, requestBody(request));
        const chatBody = responsesToChatBody(raw, defaultModel);
        if (!Array.isArray(chatBody.messages) || chatBody.messages.length === 0) {
          return reply.code(400).header("cache-control", "no-store").send({
            error: { message: "input must contain at least one message", type: "invalid_request_error", param: "input", code: "invalid_request_error" },
          });
        }
        if (raw.stream !== true) {
          return reply.header("cache-control", "no-store").send(buildResponseObject((await chatService.complete(chatBody, {
            requestId: randomUUID(), apiKeyId: auth.apiKeyId, protocol: "responses",
          })).payload, raw));
        }

        const responseId = `resp_${randomUUID().replaceAll("-", "")}`;
        const encoder = new ResponsesLiveEncoder(responseId, typeof chatBody.model === "string" ? chatBody.model : defaultModel, raw);
        beginSse(reply);
        try {
          for (const frame of encoder.start()) {
            writeSse(reply, frame);
          }
          try {
            for await (const frame of chatService.stream(chatBody, {
              requestId: randomUUID(), apiKeyId: auth.apiKeyId, protocol: "responses",
            })) {
              if (!frame.done) {
                for (const output of encoder.feed(frame.data)) {
                  writeSse(reply, output);
                }
              }
            }
            for (const frame of encoder.complete()) {
              writeSse(reply, frame);
            }
          } catch (error) {
            const failure = responseFailureFor(error);
            for (const frame of encoder.fail(failure.message, failure.code)) {
              writeSse(reply, frame);
            }
          }
        } finally {
          reply.raw.end();
        }
        return reply;
      } catch (error) {
        const failure = responseFailureFor(error);
        return reply.code(statusFor(error)).header("cache-control", "no-store").send({
          error: { ...failure, type: statusFor(error) < 500 ? "invalid_request_error" : "server_error", param: null },
        });
      }
    });
  }

  return fastifyHealthServer(app);
}

function fastifyHealthServer(app: FastifyInstance): HealthServer {
  return {
    async listen(host: string, port: number): Promise<number> {
      await app.listen({ host, port });
      const address = app.server.address();
      if (!address || typeof address === "string") {
        throw new Error("API server did not expose a TCP port");
      }
      return address.port;
    },
    close(): Promise<void> {
      return app.close();
    },
  };
}

export function createHealthServer(): HealthServer {
  return createApiServer();
}
