import { resolve } from "node:path";

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly workerLeaseMs: number;
  readonly automationWorkerEnabled: boolean;
  readonly reauthWorkers: number;
  readonly registrationMaxConcurrency: number;
  readonly tokenMaintainerEnabled: boolean;
  readonly tokenMaintainerIntervalMs: number;
  readonly tokenRefreshBatch: number;
  readonly tokenRefreshWorkers: number;
  readonly tokenRefreshSkewMs: number;
  readonly usageFlushIntervalMs: number;
  readonly usageFlushBatch: number;
  readonly ssoReauthCooldownMs: number;
  readonly oidcTokenUrl: string;
  readonly oidcDeviceUrl: string;
  readonly oidcClientId: string;
  readonly oidcScopes: string;
  readonly cfMailBaseUrl: string | null;
  readonly cfMailAdminPassword: string | null;
  readonly cfMailDomain: string | null;
  readonly registrationServiceUrl: string | null;
  readonly registrationServiceToken: string | null;
  readonly registrationTimeoutMs: number;
  readonly defaultModel: string;
  readonly legacyApiKey: string | null;
  readonly adminUsername: string;
  readonly adminPassword: string | null;
  readonly requireApiKey: "auto" | "on" | "off";
  readonly upstreamBase: string | null;
  readonly poolMode: "round_robin" | "least_used" | "random";
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[key]?.trim();
  if (!raw) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${key} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function durationSeconds(env: NodeJS.ProcessEnv, key: string, fallbackSeconds: number, minimumSeconds: number, maximumSeconds: number): number {
  return integer(env, key, fallbackSeconds, minimumSeconds, maximumSeconds) * 1_000;
}

function boolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  throw new Error(`${key} must be a boolean`);
}

function apiKeyMode(env: NodeJS.ProcessEnv): "auto" | "on" | "off" {
  const raw = (env.GROK2API_REQUIRE_API_KEY ?? "auto").trim().toLowerCase();
  if (["", "auto"].includes(raw)) {
    return "auto";
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return "on";
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return "off";
  }
  throw new Error("GROK2API_REQUIRE_API_KEY must be auto, on, or off");
}

function poolMode(env: NodeJS.ProcessEnv): "round_robin" | "least_used" | "random" {
  const raw = (env.GROK2API_ACCOUNT_MODE ?? "round_robin").trim().toLowerCase();
  if (raw === "least_used" || raw === "random") {
    return raw;
  }
  if (raw === "round_robin" || raw === "") {
    return "round_robin";
  }
  throw new Error("GROK2API_ACCOUNT_MODE must be round_robin, least_used, or random");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = resolve(env.GROK2API_DATA_DIR?.trim() || "./data-node");
  const databasePath = resolve(env.GROK2API_SQLITE_PATH?.trim() || `${dataDir}/app.sqlite`);
  return {
    host: env.GROK2API_HOST?.trim() || "0.0.0.0",
    port: integer(env, "GROK2API_PORT", 40081, 1, 65535),
    dataDir,
    databasePath,
    workerLeaseMs: integer(env, "GROK2API_WORKER_LEASE_MS", 120_000, 5_000, 3_600_000),
    automationWorkerEnabled: boolean(env, "GROK2API_AUTOMATION_WORKER", true),
    reauthWorkers: integer(env, "GROK2API_REAUTH_WORKERS", 4, 1, 8),
    registrationMaxConcurrency: integer(env, "GROK2API_REGISTRATION_MAX_CONCURRENCY", 3, 1, 8),
    tokenMaintainerEnabled: boolean(env, "GROK2API_TOKEN_MAINTAIN", true),
    tokenMaintainerIntervalMs: durationSeconds(env, "GROK2API_TOKEN_MAINTAIN_INTERVAL", 60, 5, 1_800),
    tokenRefreshBatch: integer(env, "GROK2API_TOKEN_REFRESH_BATCH", 40, 1, 500),
    tokenRefreshWorkers: integer(env, "GROK2API_TOKEN_REFRESH_WORKERS", 4, 1, 16),
    tokenRefreshSkewMs: durationSeconds(env, "GROK2API_TOKEN_REFRESH_SKEW", 180, 30, 7_200),
    usageFlushIntervalMs: durationSeconds(env, "GROK2API_USAGE_FLUSH_INTERVAL", 15, 1, 300),
    usageFlushBatch: integer(env, "GROK2API_USAGE_FLUSH_BATCH", 100, 1, 1_000),
    ssoReauthCooldownMs: durationSeconds(env, "GROK2API_SSO_REAUTH_COOLDOWN", 3_600, 60, 86_400),
    oidcTokenUrl: env.GROK2API_OIDC_TOKEN_URL?.trim() || "https://auth.x.ai/oauth2/token",
    oidcDeviceUrl: env.GROK2API_OIDC_DEVICE_URL?.trim() || "https://auth.x.ai/oauth2/device/code",
    oidcClientId: env.GROK2API_OIDC_CLIENT_ID?.trim() || "b1a00492-073a-47ea-816f-4c329264a828",
    oidcScopes: env.GROK2API_OIDC_SCOPES?.trim() || "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
    cfMailBaseUrl: env.GROK2API_CFMAIL_BASE_URL?.trim() || null,
    cfMailAdminPassword: env.GROK2API_CFMAIL_API_KEY?.trim() || null,
    cfMailDomain: env.GROK2API_CFMAIL_DOMAIN?.trim() || null,
    registrationServiceUrl: env.GROK2API_REGISTRATION_SERVICE_URL?.trim().replace(/\/+$/, "") || null,
    registrationServiceToken: env.GROK2API_REGISTRATION_TOKEN?.trim() || null,
    registrationTimeoutMs: durationSeconds(env, "GROK2API_REGISTRATION_TIMEOUT", 600, 60, 1_800),
    defaultModel: env.GROK2API_DEFAULT_MODEL?.trim() || "grok-4.5",
    legacyApiKey: env.GROK2API_API_KEY?.trim() || null,
    adminUsername: env.GROK2API_ADMIN_USERNAME?.trim() || "admin",
    adminPassword: env.GROK2API_ADMIN_PASSWORD?.trim() || "nj@363600",
    requireApiKey: apiKeyMode(env),
    upstreamBase: env.GROK2API_XAI_UPSTREAM_BASE_URL?.trim().replace(/\/+$/, "") || null,
    poolMode: poolMode(env),
  };
}
