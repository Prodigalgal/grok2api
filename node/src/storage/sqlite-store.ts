import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AutomationTaskRepository, type AutomationTask } from "../automation/task-repository.js";
import { migrations } from "./migrations.js";
import type { ApiKeyStore } from "../auth/api-key-auth.js";
import type { ModelStore, StoredModel } from "../models/catalog.js";
import type { PoolCandidate } from "../pool/picker.js";

export interface AccountRecord {
  readonly id: string;
  readonly email: string | null;
  readonly userId: string | null;
  readonly teamId: string | null;
  readonly payload: Record<string, unknown>;
  readonly expiresAt: number | null;
  readonly rowVersion: number;
  readonly updatedAt: number;
}

export interface AccountSummary {
  readonly id: string;
  readonly email: string | null;
  readonly userId: string | null;
  readonly teamId: string | null;
  readonly expiresAt: number | null;
  readonly enabled: boolean;
  readonly disabledForQuota: boolean;
  readonly disabledReason: string | null;
  readonly cooldownUntil: number | null;
  readonly poolStatus: string;
  readonly weight: number;
  readonly requestCount: number;
  readonly successCount: number;
  readonly failCount: number;
  readonly lastUsedAt: number | null;
  readonly lastError: string | null;
  readonly hasEmailMailbox: boolean;
  readonly updatedAt: number;
}

export interface AccountListResult {
  readonly accounts: readonly AccountSummary[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
}

export interface PoolSummary {
  readonly total: number;
  readonly live: number;
  readonly enabled: number;
  readonly disabled: number;
  readonly quotaDisabled: number;
  readonly cooldown: number;
  readonly expired: number;
}

export interface ApiKeySummary {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly enabled: boolean;
  readonly note: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly requestCount: number;
  readonly promptTokensTotal: number;
  readonly completionTokensTotal: number;
  readonly totalTokensTotal: number;
  readonly secret: string | null;
}

export interface CloudflareMailboxCredential {
  readonly id: string;
  readonly address: string;
  readonly accessToken: string;
}

export interface UsageEventInput {
  readonly requestId: string;
  readonly apiKeyId?: string | null;
  readonly accountId?: string | null;
  readonly model: string;
  readonly protocol: string;
  readonly success: boolean;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly createdAt?: number;
}

export interface LegacyUsageEventInput {
  readonly id: number;
  readonly requestId: string;
  readonly apiKeyId?: string | null;
  readonly accountId?: string | null;
  readonly model: string;
  readonly protocol: string;
  readonly success: boolean;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly createdAt: number;
}

export interface LegacyUsageDailyInput {
  readonly day: string;
  readonly dimension: string;
  readonly dimensionId?: string;
  readonly requests?: number;
  readonly success?: number;
  readonly fail?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
}

export interface LegacyHistoryInput {
  readonly sourceTable: "task_logs" | "admin_audit_logs";
  readonly legacyId: string;
  readonly createdAt?: number | null;
  readonly payload: Record<string, unknown>;
}

export interface LegacyOperationalHistorySnapshot {
  readonly usageEvents: readonly LegacyUsageEventInput[];
  readonly usageDaily: readonly LegacyUsageDailyInput[];
  readonly records: readonly LegacyHistoryInput[];
}

export interface LegacyOperationalHistoryCounts {
  readonly usageEvents: number;
  readonly usageDaily: number;
  readonly taskLogs: number;
  readonly auditLogs: number;
}

export interface UsageSummary {
  readonly today: UsageTotals;
  readonly total: UsageTotals;
}

export interface UsageTotals {
  readonly requests: number;
  readonly success: number;
  readonly fail: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
}

export interface UsageBreakdown extends UsageTotals {
  readonly id: string;
}

export interface UsageSeriesPoint extends UsageTotals {
  readonly day: string;
}

export interface OperationalLog {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly createdAt: number | null;
  readonly detail: Record<string, unknown>;
}

export interface AccountInput {
  readonly id: string;
  readonly email?: string | null;
  readonly userId?: string | null;
  readonly teamId?: string | null;
  readonly payload: Record<string, unknown>;
  readonly expiresAt?: number | null;
}

export interface PoolSnapshotInput {
  readonly accountId: string;
  readonly enabled?: boolean;
  readonly weight?: number;
  readonly disabledForQuota?: boolean;
  readonly disabledReason?: string | null;
  readonly quotaDisabledAt?: number | null;
  readonly quotaSource?: string | null;
  readonly lastQuota?: Record<string, unknown>;
  readonly lastProbe?: Record<string, unknown>;
  readonly blockedModels?: Record<string, unknown>;
  readonly requestCount?: number;
  readonly successCount?: number;
  readonly failCount?: number;
  readonly lastUsedAt?: number | null;
  readonly lastError?: string | null;
  readonly cooldownUntil?: number | null;
  readonly poolStatus?: string;
  readonly extra?: Record<string, unknown>;
}

export interface ApiKeySnapshotInput {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly keyHash: string;
  readonly enabled: boolean;
  readonly note?: string;
  readonly createdAt: number;
  readonly lastUsedAt?: number | null;
  readonly requestCount?: number;
  readonly promptTokensTotal?: number;
  readonly completionTokensTotal?: number;
  readonly totalTokensTotal?: number;
}

export interface ModelSnapshotInput extends Omit<StoredModel, "synthetic"> {
  readonly hidden?: boolean;
  readonly synthetic?: boolean;
  readonly fetchedAt?: number | null;
}

export interface MaintenanceCandidate extends AccountRecord {
  readonly ssoReauthNextAt: number | null;
}

export type DeviceLoginStatus = "waiting_user" | "running" | "succeeded" | "failed" | "expired";

export interface DeviceLoginSession {
  readonly id: string;
  readonly status: DeviceLoginStatus;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly pollingIntervalMs: number;
  readonly targetAccountId: string | null;
  readonly accountId: string | null;
  readonly email: string | null;
  readonly message: string;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly finishedAt: number | null;
}

export interface DeviceLoginSessionInput {
  readonly id: string;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly clientId: string;
  readonly pollingIntervalMs: number;
  readonly targetAccountId?: string | null;
  readonly expiresAt: number;
  readonly message: string;
}

interface DeviceLoginSessionRow {
  readonly id: string;
  readonly status: string;
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_url: string;
  readonly client_id: string;
  readonly polling_interval_ms: number;
  readonly target_account_id: string | null;
  readonly account_id: string | null;
  readonly email: string | null;
  readonly message: string;
  readonly error: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly expires_at: number;
  readonly finished_at: number | null;
}

interface AccountRow {
  readonly id: string;
  readonly email: string | null;
  readonly user_id: string | null;
  readonly team_id: string | null;
  readonly payload_json: string;
  readonly expires_at: number | null;
  readonly row_version: number;
  readonly updated_at: number;
}

export class SqliteStore implements ApiKeyStore, ModelStore {
  private readonly db: DatabaseSync;
  private transactionDepth = 0;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
  }

  migrate(now = Date.now()): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
    const applied = new Map<number, string>();
    const rows = this.db.prepare("SELECT version, checksum FROM schema_migrations").all() as Array<{ version: number; checksum: string }>;
    for (const row of rows) {
      applied.set(row.version, row.checksum);
    }
    for (const migration of migrations) {
      const knownChecksum = applied.get(migration.version);
      if (knownChecksum && knownChecksum !== migration.checksum) {
        throw new Error(`migration ${migration.version} checksum mismatch`);
      }
      if (knownChecksum) {
        continue;
      }
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)")
          .run(migration.version, migration.name, migration.checksum, now);
      });
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) {
      return operation();
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  saveAccount(input: AccountInput, now = Date.now()): AccountRecord {
    if (!input.id.trim()) {
      throw new Error("account id is required");
    }
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO accounts (
          id, email, user_id, team_id, payload_json,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,
          user_id = excluded.user_id,
          team_id = excluded.team_id,
          payload_json = excluded.payload_json,
          expires_at = excluded.expires_at,
          row_version = accounts.row_version + 1,
          updated_at = excluded.updated_at
      `).run(
        input.id,
        input.email ?? null,
        input.userId ?? null,
        input.teamId ?? null,
        JSON.stringify(input.payload),
        input.expiresAt ?? null,
        now,
        now,
      );
      this.db.prepare("INSERT INTO account_pool(account_id, updated_at) VALUES (?, ?) ON CONFLICT(account_id) DO NOTHING")
        .run(input.id, now);
    });
    const account = this.getAccount(input.id);
    if (!account) {
      throw new Error(`account ${input.id} was not persisted`);
    }
    return account;
  }

  getAccount(id: string): AccountRecord | null {
    const row = this.db.prepare(`
      SELECT id, email, user_id, team_id, payload_json,
             expires_at, row_version, updated_at
      FROM accounts WHERE id = ?
    `).get(id) as AccountRow | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      email: row.email,
      userId: row.user_id,
      teamId: row.team_id,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      expiresAt: row.expires_at,
      rowVersion: row.row_version,
      updatedAt: row.updated_at,
    };
  }

  saveCloudflareMailboxCredential(accountId: string, mailbox: CloudflareMailboxCredential, now = Date.now()): AccountRecord {
    if (!mailbox.id.trim() || !mailbox.address.includes("@") || !mailbox.accessToken.trim()) {
      throw new Error("Cloudflare mailbox id, address, and access token are required");
    }
    const account = this.getAccount(accountId);
    if (!account) {
      throw new Error(`account ${accountId} was not found`);
    }
    return this.saveAccount({
      id: account.id,
      email: account.email,
      userId: account.userId,
      teamId: account.teamId,
      expiresAt: account.expiresAt,
      payload: {
        ...account.payload,
        registration_mailbox: {
          provider: "cloudflare_temp_mail",
          id: mailbox.id,
          address: mailbox.address,
          access_token: mailbox.accessToken,
        },
      },
    }, now);
  }

  getCloudflareMailboxCredential(accountId: string): CloudflareMailboxCredential | null {
    const payload = this.getAccount(accountId)?.payload;
    const raw = payload?.registration_mailbox;
    if (!raw || Array.isArray(raw) || typeof raw !== "object") {
      return null;
    }
    const mailbox = raw as Record<string, unknown>;
    const provider = typeof mailbox.provider === "string" ? mailbox.provider.trim().toLowerCase() : "";
    const id = typeof mailbox.id === "string" ? mailbox.id.trim() : "";
    const address = typeof mailbox.address === "string" ? mailbox.address.trim() : "";
    const accessToken = typeof mailbox.access_token === "string" ? mailbox.access_token.trim() : "";
    return provider === "cloudflare_temp_mail" && id && address.includes("@") && accessToken
      ? { id, address, accessToken }
      : null;
  }

  listAppliedMigrations(): number[] {
    return (this.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>)
      .map((row) => row.version);
  }

  countAccounts(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM accounts").get() as { total: number };
    return row.total;
  }

  countModels(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM models").get() as { total: number };
    return row.total;
  }

  listAccountSummaries(options: {
    readonly query?: string;
    readonly status?: "active" | "disabled" | "quota_disabled" | "cooldown" | "expired";
    readonly sort?: "id" | "email" | "expires_at" | "last_used_at" | "request_count";
    readonly page?: number;
    readonly pageSize?: number;
    readonly now?: number;
  } = {}): AccountListResult {
    const page = Math.max(1, Math.trunc(options.page ?? 1));
    const pageSize = Math.max(1, Math.min(Math.trunc(options.pageSize ?? 25), 200));
    const now = options.now ?? Date.now();
    const where: string[] = [];
    const values: Array<string | number> = [];
    const query = options.query?.trim() ?? "";
    if (query) {
      const match = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      where.push("(a.id LIKE ? ESCAPE '\\' OR a.email LIKE ? ESCAPE '\\' OR a.user_id LIKE ? ESCAPE '\\')");
      values.push(match, match, match);
    }
    switch (options.status) {
      case "active":
        where.push("p.enabled = 1 AND p.disabled_for_quota = 0 AND (p.cooldown_until IS NULL OR p.cooldown_until <= ?) AND (a.expires_at IS NULL OR a.expires_at > ?)");
        values.push(now, now);
        break;
      case "disabled":
        where.push("p.enabled = 0");
        break;
      case "quota_disabled":
        where.push("p.disabled_for_quota = 1");
        break;
      case "cooldown":
        where.push("p.cooldown_until IS NOT NULL AND p.cooldown_until > ?");
        values.push(now);
        break;
      case "expired":
        where.push("a.expires_at IS NOT NULL AND a.expires_at <= ?");
        values.push(now);
        break;
      case undefined:
        break;
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const orderBy: Record<NonNullable<typeof options.sort>, string> = {
      id: "a.id ASC",
      email: "a.email COLLATE NOCASE ASC, a.id ASC",
      expires_at: "a.expires_at IS NULL, a.expires_at ASC, a.id ASC",
      last_used_at: "p.last_used_at DESC, a.id ASC",
      request_count: "p.request_count DESC, a.id ASC",
    };
    const sort = options.sort ?? "id";
    const total = (this.db.prepare(`
      SELECT COUNT(*) AS total FROM accounts a INNER JOIN account_pool p ON p.account_id = a.id ${clause}
    `).get(...values) as { total: number }).total;
    const rows = this.db.prepare(`
      SELECT a.id, a.email, a.user_id, a.team_id, a.expires_at, a.updated_at,
             CASE WHEN instr(a.payload_json, '"registration_mailbox"') > 0 THEN 1 ELSE 0 END AS has_email_mailbox,
             p.enabled, p.disabled_for_quota, p.disabled_reason, p.cooldown_until,
             p.pool_status, p.weight, p.request_count, p.success_count, p.fail_count,
             p.last_used_at, p.last_error
      FROM accounts a INNER JOIN account_pool p ON p.account_id = a.id
      ${clause} ORDER BY ${orderBy[sort]} LIMIT ? OFFSET ?
    `).all(...values, pageSize, (page - 1) * pageSize) as unknown as AccountSummaryRow[];
    return {
      accounts: rows.map(accountSummary),
      total,
      page,
      pageSize,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    };
  }

  getAccountSummary(id: string): AccountSummary | null {
    const row = this.db.prepare(`
      SELECT a.id, a.email, a.user_id, a.team_id, a.expires_at, a.updated_at,
             CASE WHEN instr(a.payload_json, '"registration_mailbox"') > 0 THEN 1 ELSE 0 END AS has_email_mailbox,
             p.enabled, p.disabled_for_quota, p.disabled_reason, p.cooldown_until,
             p.pool_status, p.weight, p.request_count, p.success_count, p.fail_count,
             p.last_used_at, p.last_error
      FROM accounts a INNER JOIN account_pool p ON p.account_id = a.id WHERE a.id = ?
    `).get(id) as AccountSummaryRow | undefined;
    return row ? accountSummary(row) : null;
  }

  poolSummary(now = Date.now()): PoolSummary {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN p.enabled = 1 THEN 1 ELSE 0 END) AS enabled,
        SUM(CASE WHEN p.enabled = 0 THEN 1 ELSE 0 END) AS disabled,
        SUM(CASE WHEN p.disabled_for_quota = 1 THEN 1 ELSE 0 END) AS quota_disabled,
        SUM(CASE WHEN p.cooldown_until IS NOT NULL AND p.cooldown_until > ? THEN 1 ELSE 0 END) AS cooldown,
        SUM(CASE WHEN a.expires_at IS NOT NULL AND a.expires_at <= ? THEN 1 ELSE 0 END) AS expired,
        SUM(CASE WHEN p.enabled = 1 AND p.disabled_for_quota = 0
                      AND (p.cooldown_until IS NULL OR p.cooldown_until <= ?)
                      AND (a.expires_at IS NULL OR a.expires_at > ?) THEN 1 ELSE 0 END) AS live
      FROM accounts a INNER JOIN account_pool p ON p.account_id = a.id
    `).get(now, now, now, now) as {
      total: number; enabled: number | null; disabled: number | null; quota_disabled: number | null;
      cooldown: number | null; expired: number | null; live: number | null;
    };
    return {
      total: row.total,
      live: row.live ?? 0,
      enabled: row.enabled ?? 0,
      disabled: row.disabled ?? 0,
      quotaDisabled: row.quota_disabled ?? 0,
      cooldown: row.cooldown ?? 0,
      expired: row.expired ?? 0,
    };
  }

  listRefreshCandidates(options: {
    readonly skewMs: number;
    readonly limit: number;
    readonly force?: boolean;
    readonly now?: number;
  }): MaintenanceCandidate[] {
    const now = options.now ?? Date.now();
    const limit = Math.max(1, Math.min(options.limit, 500));
    const dueAt = now + Math.max(0, options.skewMs);
    const rows = this.db.prepare(`
      SELECT a.id, a.email, a.user_id, a.team_id, a.payload_json,
             a.expires_at, a.row_version, a.updated_at, p.sso_reauth_next_at
      FROM accounts a
      INNER JOIN account_pool p ON p.account_id = a.id
      WHERE p.enabled = 1 AND p.disabled_for_quota = 0
      ORDER BY CASE WHEN a.expires_at IS NULL THEN 0 ELSE 1 END, a.expires_at, a.id
      LIMIT ?
    `).all(Math.max(limit * 4, 100)) as unknown as Array<AccountRow & { sso_reauth_next_at: number | null }>;
    const candidates: MaintenanceCandidate[] = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      if (!hasNonEmptyString(payload, "refresh_token") || truthy(payload.refresh_invalid)) {
        continue;
      }
      if (!options.force && row.expires_at !== null && row.expires_at > dueAt) {
        continue;
      }
      candidates.push({
        id: row.id,
        email: row.email,
        userId: row.user_id,
        teamId: row.team_id,
        payload,
        expiresAt: row.expires_at,
        rowVersion: row.row_version,
        updatedAt: row.updated_at,
        ssoReauthNextAt: row.sso_reauth_next_at,
      });
      if (candidates.length >= limit) {
        break;
      }
    }
    return candidates;
  }

  recordRefreshSuccess(account: AccountInput, now = Date.now()): AccountRecord {
    const saved = this.saveAccount(account, now);
    this.db.prepare(`
      UPDATE account_pool
      SET pool_status = CASE
            WHEN enabled = 0 THEN 'disabled'
            WHEN disabled_for_quota = 1 THEN 'quota_disabled'
            WHEN cooldown_until IS NOT NULL AND cooldown_until > ? THEN 'cooldown'
            ELSE 'normal'
          END,
          last_error = NULL,
          last_renew_status = 'ok',
          last_renew_at = ?,
          renew_fail_count = 0,
          sso_reauth_failed_at = NULL,
          sso_reauth_next_at = NULL,
          sso_reauth_error = NULL,
          updated_at = ?
      WHERE account_id = ?
    `).run(now, now, now, saved.id);
    return saved;
  }

  recordRefreshFailure(accountId: string, error: string, permanent: boolean, now = Date.now()): AccountRecord {
    const account = this.getAccount(accountId);
    if (!account) {
      throw new Error(`account ${accountId} was not found`);
    }
    const reason = error.trim().slice(0, 400) || "token refresh failed";
    const payload = { ...account.payload };
    if (permanent) {
      payload.refresh_invalid = true;
      payload.refresh_invalid_reason = reason;
      payload.refresh_invalid_at = now;
    }
    this.transaction(() => {
      if (permanent) {
        this.db.prepare(`
          UPDATE accounts
          SET payload_json = ?, row_version = row_version + 1, updated_at = ?
          WHERE id = ?
        `).run(JSON.stringify(payload), now, accountId);
      }
      this.db.prepare(`
        UPDATE account_pool
        SET pool_status = CASE
              WHEN enabled = 0 THEN 'disabled'
              WHEN disabled_for_quota = 1 THEN 'quota_disabled'
              ELSE 'expired'
            END,
            last_error = ?,
            last_renew_status = ?,
            last_renew_at = ?,
            renew_fail_count = renew_fail_count + 1,
            updated_at = ?
        WHERE account_id = ?
      `).run(reason, permanent ? "invalid" : "fail", now, now, accountId);
    });
    const updated = this.getAccount(accountId);
    if (!updated) {
      throw new Error(`account ${accountId} disappeared while recording refresh failure`);
    }
    return updated;
  }

  markSsoReauthQueued(accountId: string, now = Date.now()): void {
    this.db.prepare(`
      UPDATE account_pool
      SET sso_reauth_attempted_at = ?, last_renew_status = 'sso_queued',
          last_renew_at = ?, updated_at = ?
      WHERE account_id = ?
    `).run(now, now, now, accountId);
  }

  markSsoReauthFailure(accountId: string, error: string, cooldownMs: number, now = Date.now()): void {
    const reason = error.trim().slice(0, 400) || "SSO reauthentication failed";
    this.db.prepare(`
      UPDATE account_pool
      SET pool_status = CASE
            WHEN enabled = 0 THEN 'disabled'
            WHEN disabled_for_quota = 1 THEN 'quota_disabled'
            ELSE 'expired'
          END,
          last_error = ?, last_renew_status = 'sso_failed', last_renew_at = ?,
          sso_reauth_failed_at = ?, sso_reauth_next_at = ?, sso_reauth_error = ?, updated_at = ?
      WHERE account_id = ?
    `).run(reason, now, now, now + Math.max(60_000, cooldownMs), reason, now, accountId);
  }

  markSsoReauthBanned(accountId: string, error: string, now = Date.now()): void {
    const reason = `banned: ${(error.trim() || "xAI OAuth access denied").slice(0, 380)}`;
    this.db.prepare(`
      UPDATE account_pool
      SET enabled = 0, pool_status = 'disabled', disabled_reason = ?,
          last_error = ?, last_renew_status = 'sso_banned', last_renew_at = ?,
          sso_reauth_failed_at = ?, sso_reauth_next_at = NULL,
          sso_reauth_error = ?, updated_at = ?
      WHERE account_id = ?
    `).run(reason, reason, now, now, reason, now, accountId);
  }

  automationTasks(): AutomationTaskRepository {
    return new AutomationTaskRepository(this.db);
  }

  getAutomationTaskByIdempotencyKey(idempotencyKey: string): AutomationTask | null {
    return this.automationTasks().getByIdempotencyKey(idempotencyKey);
  }

  createDeviceLoginSession(input: DeviceLoginSessionInput, now = Date.now()): DeviceLoginSession {
    this.db.prepare(`
      INSERT INTO device_login_sessions (
        id, status, device_code, user_code, verification_url, client_id,
        polling_interval_ms, target_account_id, message, created_at, updated_at, expires_at
      ) VALUES (?, 'waiting_user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.deviceCode,
      input.userCode,
      input.verificationUrl,
      input.clientId,
      input.pollingIntervalMs,
      input.targetAccountId ?? null,
      input.message,
      now,
      now,
      input.expiresAt,
    );
    const session = this.getDeviceLoginSession(input.id);
    if (!session) {
      throw new Error(`device login session ${input.id} was not persisted`);
    }
    return session;
  }

  getDeviceLoginSession(id: string): DeviceLoginSession | null {
    const row = this.deviceLoginRow(id);
    return row ? publicDeviceLoginSession(row) : null;
  }

  getDeviceLoginSessionForPolling(id: string): (DeviceLoginSession & { readonly deviceCode: string; readonly clientId: string }) | null {
    const row = this.deviceLoginRow(id);
    return row ? { ...publicDeviceLoginSession(row), deviceCode: row.device_code, clientId: row.client_id } : null;
  }

  listActiveDeviceLoginSessionIds(now = Date.now()): string[] {
    return (this.db.prepare(`
      SELECT id FROM device_login_sessions
      WHERE status IN ('waiting_user', 'running') AND expires_at > ?
      ORDER BY created_at
    `).all(now) as Array<{ id: string }>).map((row) => row.id);
  }

  listDeviceLoginSessions(limit = 100): DeviceLoginSession[] {
    const rows = this.db.prepare(`
      SELECT * FROM device_login_sessions ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(Math.max(1, Math.min(limit, 500))) as unknown as DeviceLoginSessionRow[];
    return rows.map(publicDeviceLoginSession);
  }

  updateDeviceLoginSession(
    id: string,
    patch: {
      readonly status: DeviceLoginStatus;
      readonly pollingIntervalMs?: number;
      readonly accountId?: string | null;
      readonly email?: string | null;
      readonly message: string;
      readonly error?: string | null;
      readonly finishedAt?: number | null;
    },
    now = Date.now(),
  ): DeviceLoginSession {
    const previous = this.deviceLoginRow(id);
    if (!previous) {
      throw new Error(`device login session ${id} was not found`);
    }
    this.db.prepare(`
      UPDATE device_login_sessions
      SET status = ?, polling_interval_ms = ?, account_id = ?, email = ?, message = ?,
          error = ?, updated_at = ?, finished_at = ?
      WHERE id = ?
    `).run(
      patch.status,
      patch.pollingIntervalMs ?? previous.polling_interval_ms,
      patch.accountId === undefined ? previous.account_id : patch.accountId,
      patch.email === undefined ? previous.email : patch.email,
      patch.message,
      patch.error === undefined ? previous.error : patch.error,
      now,
      patch.finishedAt === undefined ? previous.finished_at : patch.finishedAt,
      id,
    );
    const updated = this.getDeviceLoginSession(id);
    if (!updated) {
      throw new Error(`device login session ${id} disappeared during update`);
    }
    return updated;
  }

  listPublicModels(): readonly StoredModel[] {
    const rows = this.db.prepare(`
      SELECT id, name, description, owned_by, synthetic, context_window,
             supports_reasoning_effort, extra_json, sort_order
      FROM models WHERE hidden = 0 ORDER BY sort_order, id
    `).all() as Array<{
      id: string;
      name: string | null;
      description: string | null;
      owned_by: string;
      synthetic: number;
      context_window: number | null;
      supports_reasoning_effort: number | null;
      extra_json: string;
      sort_order: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      ownedBy: row.owned_by || "xai",
      synthetic: row.synthetic !== 0,
      contextWindow: row.context_window,
      supportsReasoningEffort: row.supports_reasoning_effort === null ? null : row.supports_reasoning_effort !== 0,
      extra: JSON.parse(row.extra_json) as Record<string, unknown>,
      sortOrder: row.sort_order,
    }));
  }

  replaceModels(models: readonly Omit<StoredModel, "synthetic">[], now = Date.now()): number {
    this.transaction(() => {
      this.db.prepare("DELETE FROM models WHERE synthetic = 0").run();
      const statement = this.db.prepare(`
        INSERT INTO models (
          id, name, description, owned_by, hidden, synthetic, context_window,
          supports_reasoning_effort, extra_json, sort_order, fetched_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)
      `);
      for (const [index, model] of models.entries()) {
        if (!model.id.trim()) {
          continue;
        }
        statement.run(
          model.id,
          model.name,
          model.description,
          model.ownedBy || "xai",
          model.contextWindow,
          model.supportsReasoningEffort === null ? null : model.supportsReasoningEffort ? 1 : 0,
          JSON.stringify(model.extra),
          model.sortOrder || (index + 1) * 10,
          now,
          now,
        );
      }
    });
    return this.listPublicModels().length;
  }

  replaceModelSnapshot(models: readonly ModelSnapshotInput[], now = Date.now()): number {
    this.transaction(() => {
      this.db.prepare("DELETE FROM models").run();
      const statement = this.db.prepare(`
        INSERT INTO models (
          id, name, description, owned_by, hidden, synthetic, context_window,
          supports_reasoning_effort, extra_json, sort_order, fetched_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [index, model] of models.entries()) {
        if (!model.id.trim()) {
          continue;
        }
        statement.run(
          model.id,
          model.name,
          model.description,
          model.ownedBy || "xai",
          model.hidden ? 1 : 0,
          model.synthetic ? 1 : 0,
          model.contextWindow,
          model.supportsReasoningEffort === null ? null : model.supportsReasoningEffort ? 1 : 0,
          JSON.stringify(model.extra),
          model.sortOrder || (index + 1) * 10,
          model.fetchedAt ?? now,
          now,
        );
      }
    });
    return models.filter((model) => model.id.trim()).length;
  }

  replaceApiKeySnapshot(keys: readonly ApiKeySnapshotInput[]): number {
    this.transaction(() => {
      this.db.prepare("DELETE FROM api_keys").run();
      const statement = this.db.prepare(`
        INSERT INTO api_keys (
          id, name, prefix, key_hash, enabled, note, created_at, last_used_at,
          request_count, prompt_tokens_total, completion_tokens_total, total_tokens_total
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const key of keys) {
        statement.run(
          key.id,
          key.name,
          key.prefix,
          key.keyHash,
          key.enabled ? 1 : 0,
          key.note ?? "",
          key.createdAt,
          key.lastUsedAt ?? null,
          key.requestCount ?? 0,
          key.promptTokensTotal ?? 0,
          key.completionTokensTotal ?? 0,
          key.totalTokensTotal ?? 0,
        );
      }
    });
    return keys.length;
  }

  replaceSettingsSnapshot(settings: Readonly<Record<string, unknown>>, now = Date.now()): number {
    this.transaction(() => {
      this.db.prepare("DELETE FROM app_settings").run();
      const statement = this.db.prepare("INSERT INTO app_settings(key, value_json, updated_at) VALUES (?, ?, ?)");
      for (const [key, value] of Object.entries(settings)) {
        if (!key.trim()) {
          continue;
        }
        statement.run(key, JSON.stringify(value), now);
      }
    });
    return Object.keys(settings).filter((key) => key.trim()).length;
  }

  getSetting(key: string): unknown | null {
    const row = this.db.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as unknown : null;
  }

  replaceLegacyOperationalHistory(snapshot: LegacyOperationalHistorySnapshot): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM usage_events").run();
      this.db.prepare("DELETE FROM usage_daily").run();
      this.db.prepare("DELETE FROM legacy_history").run();
      const usageEvent = this.db.prepare(`
        INSERT INTO usage_events(
          id, request_id, api_key_id, account_id, model, protocol, success,
          prompt_tokens, completion_tokens, total_tokens, cache_read_tokens, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of snapshot.usageEvents) {
        if (!Number.isSafeInteger(event.id) || event.id <= 0 || !event.requestId.trim() || !event.model.trim() || !event.protocol.trim()) {
          throw new Error("legacy usage event contains invalid identity fields");
        }
        if (!Number.isSafeInteger(event.createdAt) || event.createdAt <= 0) {
          throw new Error("legacy usage event createdAt is invalid");
        }
        const promptTokens = nonNegativeInteger(event.promptTokens);
        const completionTokens = nonNegativeInteger(event.completionTokens);
        usageEvent.run(
          event.id,
          event.requestId.trim(),
          event.apiKeyId?.trim() || null,
          event.accountId?.trim() || null,
          event.model.trim(),
          event.protocol.trim(),
          event.success ? 1 : 0,
          promptTokens,
          completionTokens,
          Math.max(nonNegativeInteger(event.totalTokens), promptTokens + completionTokens),
          Math.min(nonNegativeInteger(event.cacheReadTokens), promptTokens),
          event.createdAt,
        );
      }
      const usageDaily = this.db.prepare(`
        INSERT INTO usage_daily(
          day, dim, dim_id, requests, success, fail, prompt_tokens,
          completion_tokens, total_tokens, cache_read_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const daily of snapshot.usageDaily) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(daily.day) || !daily.dimension.trim()) {
          throw new Error("legacy usage daily row contains invalid dimensions");
        }
        usageDaily.run(
          daily.day,
          daily.dimension.trim(),
          daily.dimensionId?.trim() || "",
          nonNegativeInteger(daily.requests),
          nonNegativeInteger(daily.success),
          nonNegativeInteger(daily.fail),
          nonNegativeInteger(daily.promptTokens),
          nonNegativeInteger(daily.completionTokens),
          nonNegativeInteger(daily.totalTokens),
          nonNegativeInteger(daily.cacheReadTokens),
        );
      }
      const history = this.db.prepare(`
        INSERT INTO legacy_history(source_table, legacy_id, created_at, payload_json)
        VALUES (?, ?, ?, ?)
      `);
      for (const record of snapshot.records) {
        if (!record.legacyId.trim()) {
          throw new Error("legacy history record id is required");
        }
        history.run(
          record.sourceTable,
          record.legacyId.trim(),
          record.createdAt ?? null,
          JSON.stringify(record.payload),
        );
      }
    });
  }

  legacyOperationalHistoryCounts(): LegacyOperationalHistoryCounts {
    const count = (sql: string, ...parameters: string[]): number => {
      const row = this.db.prepare(sql).get(...parameters) as { total: number };
      return row.total;
    };
    return {
      usageEvents: count("SELECT COUNT(*) AS total FROM usage_events"),
      usageDaily: count("SELECT COUNT(*) AS total FROM usage_daily"),
      taskLogs: count("SELECT COUNT(*) AS total FROM legacy_history WHERE source_table = ?", "task_logs"),
      auditLogs: count("SELECT COUNT(*) AS total FROM legacy_history WHERE source_table = ?", "admin_audit_logs"),
    };
  }

  listSettings(): Record<string, unknown> {
    const rows = this.db.prepare("SELECT key, value_json FROM app_settings ORDER BY key").all() as Array<{ key: string; value_json: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value_json) as unknown]));
  }

  updateSettings(settings: Readonly<Record<string, unknown>>, now = Date.now()): number {
    const statement = this.db.prepare(`
      INSERT INTO app_settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `);
    this.transaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        if (!key.trim()) throw new Error("setting key cannot be empty");
        statement.run(key.trim(), JSON.stringify(value), now);
      }
    });
    return Object.keys(settings).length;
  }

  migrationVerificationData(): {
    readonly accounts: readonly {
      readonly id: string;
      readonly email: string | null;
      readonly userId: string | null;
      readonly teamId: string | null;
      readonly payload: Record<string, unknown>;
    }[];
    readonly apiKeys: readonly { readonly id: string; readonly enabled: boolean; readonly keyHash: string }[];
    readonly models: readonly { readonly id: string; readonly hidden: boolean }[];
  } {
    const accounts = (this.db.prepare(`
      SELECT id, email, user_id, team_id, payload_json FROM accounts ORDER BY id
    `).all() as Array<{ id: string; email: string | null; user_id: string | null; team_id: string | null; payload_json: string }>).map((row) => ({
      id: row.id,
      email: row.email,
      userId: row.user_id,
      teamId: row.team_id,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));
    const apiKeys = (this.db.prepare(`
      SELECT id, enabled, key_hash FROM api_keys ORDER BY id
    `).all() as Array<{ id: string; enabled: number; key_hash: string }>).map((row) => ({
      id: row.id,
      enabled: row.enabled !== 0,
      keyHash: row.key_hash,
    }));
    const models = (this.db.prepare(`
      SELECT id, hidden FROM models ORDER BY id
    `).all() as Array<{ id: string; hidden: number }>).map((row) => ({
      id: row.id,
      hidden: row.hidden !== 0,
    }));
    return { accounts, apiKeys, models };
  }

  recordUsageBatch(events: readonly UsageEventInput[]): number {
    let recorded = 0;
    this.transaction(() => {
      const insert = this.db.prepare(`
        INSERT INTO usage_events(
          request_id, api_key_id, account_id, model, protocol, success,
          prompt_tokens, completion_tokens, total_tokens, cache_read_tokens, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO NOTHING
      `);
      const aggregate = this.db.prepare(`
        INSERT INTO usage_daily(
          day, dim, dim_id, requests, success, fail, prompt_tokens,
          completion_tokens, total_tokens, cache_read_tokens
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, dim, dim_id) DO UPDATE SET
          requests = usage_daily.requests + 1,
          success = usage_daily.success + excluded.success,
          fail = usage_daily.fail + excluded.fail,
          prompt_tokens = usage_daily.prompt_tokens + excluded.prompt_tokens,
          completion_tokens = usage_daily.completion_tokens + excluded.completion_tokens,
          total_tokens = usage_daily.total_tokens + excluded.total_tokens,
          cache_read_tokens = usage_daily.cache_read_tokens + excluded.cache_read_tokens
      `);
      const updateKeyUsage = this.db.prepare(`
        UPDATE api_keys
        SET prompt_tokens_total = prompt_tokens_total + ?,
            completion_tokens_total = completion_tokens_total + ?,
            total_tokens_total = total_tokens_total + ?
        WHERE id = ? AND enabled = 1
      `);
      for (const input of events) {
        const requestId = input.requestId.trim();
        const model = input.model.trim();
        const protocol = input.protocol.trim();
        if (!requestId || !model || !protocol) {
          throw new Error("usage event request id, model, and protocol are required");
        }
        const createdAt = input.createdAt ?? Date.now();
        const promptTokens = nonNegativeInteger(input.promptTokens);
        const completionTokens = nonNegativeInteger(input.completionTokens);
        const totalTokens = Math.max(nonNegativeInteger(input.totalTokens), promptTokens + completionTokens);
        const cacheReadTokens = Math.min(nonNegativeInteger(input.cacheReadTokens), promptTokens);
        const success = input.success ? 1 : 0;
        const result = insert.run(
          requestId,
          input.apiKeyId?.trim() || null,
          input.accountId?.trim() || null,
          model,
          protocol,
          success,
          promptTokens,
          completionTokens,
          totalTokens,
          cacheReadTokens,
          createdAt,
        );
        if (result.changes !== 1) {
          continue;
        }
        recorded += 1;
        const day = chinaDay(createdAt);
        const dimensions: Array<readonly [string, string]> = [
          ["global", ""],
          ["model", model],
          ...(input.apiKeyId?.trim() ? [["key", input.apiKeyId.trim()] as const] : []),
          ...(input.accountId?.trim() ? [["account", input.accountId.trim()] as const] : []),
        ];
        for (const [dimension, id] of dimensions) {
          aggregate.run(day, dimension, id, success, success ? 0 : 1, promptTokens, completionTokens, totalTokens, cacheReadTokens);
        }
        if (success && input.apiKeyId?.trim() && input.apiKeyId.trim() !== "env") {
          updateKeyUsage.run(promptTokens, completionTokens, totalTokens, input.apiKeyId.trim());
        }
      }
    });
    return recorded;
  }

  usageSummary(now = Date.now()): UsageSummary {
    const totals = (where: string, parameters: readonly (string | number)[]): UsageTotals => {
      const row = this.db.prepare(`
        SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(success), 0) AS success,
               COALESCE(SUM(fail), 0) AS fail, COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
               COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
               COALESCE(SUM(total_tokens), 0) AS total_tokens,
               COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
        FROM usage_daily WHERE dim = 'global' ${where}
      `).get(...parameters) as unknown as UsageTotalsRow;
      return {
        requests: row.requests,
        success: row.success,
        fail: row.fail,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        totalTokens: row.total_tokens,
        cacheReadTokens: row.cache_read_tokens,
      };
    };
    return { today: totals("AND day = ?", [chinaDay(now)]), total: totals("", []) };
  }

  usageSeries(days = 14, now = Date.now()): UsageSeriesPoint[] {
    const since = now - Math.max(1, Math.min(365, days)) * 86_400_000;
    const rows = this.db.prepare(`
      SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
             COUNT(*) AS requests, SUM(success) AS success, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS fail,
             SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens,
             SUM(total_tokens) AS total_tokens, SUM(cache_read_tokens) AS cache_read_tokens
      FROM usage_events WHERE created_at >= ? GROUP BY day ORDER BY day
    `).all(since) as Array<{ day: string; requests: number; success: number; fail: number; prompt_tokens: number; completion_tokens: number; total_tokens: number; cache_read_tokens: number }>;
    return rows.map((row) => ({ day: row.day, ...usageTotalsFromRow(row) }));
  }

  usageBreakdown(dimension: "api_key_id" | "account_id" | "model", limit = 100): UsageBreakdown[] {
    const safeLimit = Math.max(1, Math.min(500, limit));
    const rows = this.db.prepare(`
      SELECT COALESCE(${dimension}, '') AS id, COUNT(*) AS requests, SUM(success) AS success,
             SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS fail, SUM(prompt_tokens) AS prompt_tokens,
             SUM(completion_tokens) AS completion_tokens, SUM(total_tokens) AS total_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens
      FROM usage_events GROUP BY ${dimension} ORDER BY total_tokens DESC, requests DESC LIMIT ?
    `).all(safeLimit) as Array<{ id: string; requests: number; success: number; fail: number; prompt_tokens: number; completion_tokens: number; total_tokens: number; cache_read_tokens: number }>;
    return rows.map((row) => ({ id: row.id || "unknown", ...usageTotalsFromRow(row) }));
  }

  usageEvents(limit = 100): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT request_id, api_key_id, account_id, model, protocol, success, prompt_tokens,
             completion_tokens, total_tokens, cache_read_tokens, created_at
      FROM usage_events ORDER BY created_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;
  }

  listOperationalLogs(limit = 100): OperationalLog[] {
    const taskLogs = this.automationTasks().list({ limit: Math.max(1, Math.min(500, limit)) }).map((task) => ({
      id: task.id, type: task.kind, status: task.status, createdAt: task.createdAt,
      detail: { result: task.result, error: task.error, attempts: task.attempts },
    }));
    const legacy = (this.db.prepare(`
      SELECT source_table, legacy_id, created_at, payload_json FROM legacy_history ORDER BY created_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, limit))) as Array<{ source_table: string; legacy_id: string; created_at: number | null; payload_json: string }>).map((row) => {
      const detail = JSON.parse(row.payload_json) as Record<string, unknown>;
      return { id: `legacy:${row.source_table}:${row.legacy_id}`, type: row.source_table, status: String(detail.status ?? "historical"), createdAt: row.created_at, detail };
    });
    return [...taskLogs, ...legacy].sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0)).slice(0, limit);
  }

  exportAccounts(): Record<string, Record<string, unknown>> {
    const rows = this.db.prepare("SELECT id, payload_json FROM accounts ORDER BY id").all() as Array<{ id: string; payload_json: string }>;
    return Object.fromEntries(rows.map((row) => [row.id, JSON.parse(row.payload_json) as Record<string, unknown>]));
  }

  applyPoolSnapshot(input: PoolSnapshotInput, now = Date.now()): void {
    if (!input.accountId.trim()) {
      throw new Error("pool snapshot account id is required");
    }
    const exists = this.db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(input.accountId);
    if (!exists) {
      throw new Error(`pool snapshot account ${input.accountId} was not imported`);
    }
    this.db.prepare(`
      INSERT INTO account_pool (
        account_id, enabled, weight, disabled_for_quota, disabled_reason,
        quota_disabled_at, quota_source, last_quota_json, last_probe_json,
        blocked_models_json, request_count, success_count, fail_count, last_used_at,
        last_error, cooldown_until, pool_status, extra_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        enabled = excluded.enabled, weight = excluded.weight,
        disabled_for_quota = excluded.disabled_for_quota,
        disabled_reason = excluded.disabled_reason, quota_disabled_at = excluded.quota_disabled_at,
        quota_source = excluded.quota_source, last_quota_json = excluded.last_quota_json,
        last_probe_json = excluded.last_probe_json, blocked_models_json = excluded.blocked_models_json,
        request_count = excluded.request_count, success_count = excluded.success_count,
        fail_count = excluded.fail_count, last_used_at = excluded.last_used_at,
        last_error = excluded.last_error, cooldown_until = excluded.cooldown_until,
        pool_status = excluded.pool_status, extra_json = excluded.extra_json,
        updated_at = excluded.updated_at
    `).run(
      input.accountId,
      input.enabled === false ? 0 : 1,
      Math.max(0, Math.trunc(input.weight ?? 1)),
      input.disabledForQuota ? 1 : 0,
      input.disabledReason ?? null,
      input.quotaDisabledAt ?? null,
      input.quotaSource ?? null,
      JSON.stringify(input.lastQuota ?? {}),
      JSON.stringify(input.lastProbe ?? {}),
      JSON.stringify(input.blockedModels ?? {}),
      Math.max(0, Math.trunc(input.requestCount ?? 0)),
      Math.max(0, Math.trunc(input.successCount ?? 0)),
      Math.max(0, Math.trunc(input.failCount ?? 0)),
      input.lastUsedAt ?? null,
      input.lastError ?? null,
      input.cooldownUntil ?? null,
      input.poolStatus?.trim() || "normal",
      JSON.stringify(input.extra ?? {}),
      now,
    );
  }

  hasEnabledApiKeys(): boolean {
    const row = this.db.prepare("SELECT EXISTS(SELECT 1 FROM api_keys WHERE enabled = 1) AS enabled").get() as { enabled: number };
    return row.enabled !== 0;
  }

  findEnabledApiKeyByHash(hash: string): { readonly id: string } | null {
    const row = this.db.prepare("SELECT id FROM api_keys WHERE key_hash = ? AND enabled = 1").get(hash) as { id: string } | undefined;
    return row ?? null;
  }

  listApiKeySummaries(): ApiKeySummary[] {
    const rows = this.db.prepare(`
      SELECT id, name, prefix, enabled, note, created_at, last_used_at, request_count,
             secret_value,
             prompt_tokens_total, completion_tokens_total, total_tokens_total
      FROM api_keys ORDER BY created_at DESC, id DESC
    `).all() as unknown as ApiKeySummaryRow[];
    return rows.map(apiKeySummary);
  }

  getApiKeySummary(id: string): ApiKeySummary | null {
    const row = this.db.prepare(`
      SELECT id, name, prefix, enabled, note, created_at, last_used_at, request_count,
             secret_value,
             prompt_tokens_total, completion_tokens_total, total_tokens_total
      FROM api_keys WHERE id = ?
    `).get(id) as ApiKeySummaryRow | undefined;
    return row ? apiKeySummary(row) : null;
  }

  createApiKey(input: {
    readonly id: string;
    readonly name: string;
    readonly prefix: string;
    readonly keyHash: string;
    readonly secret?: string | null;
    readonly note?: string;
  }, now = Date.now()): ApiKeySummary {
    if (!input.id.trim() || !input.name.trim() || !input.prefix.trim() || !/^[a-f0-9]{64}$/i.test(input.keyHash)) {
      throw new Error("API key id, name, prefix, and SHA-256 hash are required");
    }
    this.db.prepare(`
      INSERT INTO api_keys(id, name, prefix, key_hash, secret_value, enabled, note, created_at, request_count, prompt_tokens_total, completion_tokens_total, total_tokens_total)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, 0, 0, 0)
    `).run(input.id, input.name.trim(), input.prefix.trim(), input.keyHash.toLowerCase(), input.secret?.trim() || null, input.note?.trim() ?? "", now);
    const key = this.getApiKeySummary(input.id);
    if (!key) {
      throw new Error(`API key ${input.id} was not persisted`);
    }
    return key;
  }

  updateApiKey(id: string, patch: { readonly name?: string; readonly note?: string; readonly enabled?: boolean }): ApiKeySummary {
    const current = this.getApiKeySummary(id);
    if (!current) {
      throw new Error(`API key ${id} was not found`);
    }
    const name = patch.name === undefined ? current.name : patch.name.trim();
    if (!name) {
      throw new Error("API key name is required");
    }
    this.db.prepare("UPDATE api_keys SET name = ?, note = ?, enabled = ? WHERE id = ?")
      .run(name, patch.note === undefined ? current.note : patch.note.trim(), patch.enabled === undefined ? (current.enabled ? 1 : 0) : patch.enabled ? 1 : 0, id);
    return this.getApiKeySummary(id)!;
  }

  rotateApiKey(id: string, prefix: string, keyHash: string, secret?: string | null): ApiKeySummary {
    if (!prefix.trim() || !/^[a-f0-9]{64}$/i.test(keyHash)) {
      throw new Error("API key prefix and SHA-256 hash are required");
    }
    const result = this.db.prepare("UPDATE api_keys SET prefix = ?, key_hash = ?, secret_value = ?, enabled = 1 WHERE id = ?")
      .run(prefix.trim(), keyHash.toLowerCase(), secret?.trim() || null, id);
    if (result.changes !== 1) {
      throw new Error(`API key ${id} was not found`);
    }
    return this.getApiKeySummary(id)!;
  }

  deleteApiKey(id: string): boolean {
    return this.db.prepare("DELETE FROM api_keys WHERE id = ?").run(id).changes === 1;
  }

  touchApiKeyUsage(id: string, now = Date.now()): void {
    this.db.prepare("UPDATE api_keys SET request_count = request_count + 1, last_used_at = ? WHERE id = ? AND enabled = 1").run(now, id);
  }

  listPoolCandidates(): PoolCandidate[] {
    const rows = this.db.prepare(`
      SELECT a.id, a.email, a.user_id, a.team_id, a.payload_json, a.expires_at,
             p.enabled, p.disabled_for_quota, p.cooldown_until, p.blocked_models_json,
             p.request_count, p.weight
      FROM accounts a
      INNER JOIN account_pool p ON p.account_id = a.id
      ORDER BY p.weight DESC, p.request_count ASC, a.id ASC
    `).all() as Array<{
      id: string;
      email: string | null;
      user_id: string | null;
      team_id: string | null;
      payload_json: string;
      expires_at: number | null;
      enabled: number;
      disabled_for_quota: number;
      cooldown_until: number | null;
      blocked_models_json: string;
      request_count: number;
      weight: number;
    }>;
    const candidates: PoolCandidate[] = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      const token = [payload.key, payload.access_token, payload.token]
        .find((value): value is string => typeof value === "string" && value.trim() !== "") ?? "";
      if (!token) {
        continue;
      }
      candidates.push({
        id: row.id,
        token,
        email: row.email ?? (typeof payload.email === "string" ? payload.email : null),
        userId: row.user_id ?? (typeof payload.user_id === "string" ? payload.user_id : typeof payload.principal_id === "string" ? payload.principal_id : null),
        teamId: row.team_id ?? (typeof payload.team_id === "string" ? payload.team_id : null),
        expiresAt: row.expires_at,
        enabled: row.enabled !== 0,
        disabledForQuota: row.disabled_for_quota !== 0,
        cooldownUntil: row.cooldown_until,
        blockedModels: JSON.parse(row.blocked_models_json) as Record<string, unknown>,
        requestCount: row.request_count,
        weight: row.weight,
      });
    }
    return candidates;
  }

  updatePoolEligibility(
    accountId: string,
    patch: { readonly enabled?: boolean; readonly disabledForQuota?: boolean; readonly cooldownUntil?: number | null; readonly blockedModels?: Record<string, unknown> },
    now = Date.now(),
  ): void {
    const current = this.db.prepare(`
      SELECT enabled, disabled_for_quota, cooldown_until, blocked_models_json FROM account_pool WHERE account_id = ?
    `).get(accountId) as { enabled: number; disabled_for_quota: number; cooldown_until: number | null; blocked_models_json: string } | undefined;
    if (!current) {
      throw new Error(`account ${accountId} has no pool record`);
    }
    this.db.prepare(`
      UPDATE account_pool SET enabled = ?, disabled_for_quota = ?, cooldown_until = ?, blocked_models_json = ?,
          pool_status = CASE
            WHEN ? = 0 THEN 'disabled'
            WHEN ? = 1 THEN 'quota_disabled'
            WHEN ? IS NOT NULL AND ? > ? THEN 'cooldown'
            ELSE 'normal'
          END,
          updated_at = ?
      WHERE account_id = ?
    `).run(
      patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
      patch.disabledForQuota === undefined ? current.disabled_for_quota : patch.disabledForQuota ? 1 : 0,
      patch.cooldownUntil === undefined ? current.cooldown_until : patch.cooldownUntil,
      patch.blockedModels === undefined ? current.blocked_models_json : JSON.stringify(patch.blockedModels),
      patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
      patch.disabledForQuota === undefined ? current.disabled_for_quota : patch.disabledForQuota ? 1 : 0,
      patch.cooldownUntil === undefined ? current.cooldown_until : patch.cooldownUntil,
      patch.cooldownUntil === undefined ? current.cooldown_until : patch.cooldownUntil,
      now,
      now,
      accountId,
    );
  }

  enableAllRecoverableAccounts(now = Date.now()): { enabled: number; banned: number } {
    const banned = this.db.prepare(`
      SELECT COUNT(*) AS total FROM account_pool
      WHERE lower(COALESCE(disabled_reason, '')) LIKE '%banned%'
         OR lower(COALESCE(disabled_reason, '')) LIKE '%suspended%'
         OR lower(COALESCE(disabled_reason, '')) LIKE '%封禁%'
    `).get() as { total: number };
    const result = this.db.prepare(`
      UPDATE account_pool
      SET enabled = 1, disabled_for_quota = 0, disabled_reason = NULL,
          cooldown_until = NULL, pool_status = 'normal', updated_at = ?
      WHERE lower(COALESCE(disabled_reason, '')) NOT LIKE '%banned%'
        AND lower(COALESCE(disabled_reason, '')) NOT LIKE '%suspended%'
        AND lower(COALESCE(disabled_reason, '')) NOT LIKE '%封禁%'
        AND (enabled <> 1 OR disabled_for_quota <> 0 OR disabled_reason IS NOT NULL
          OR cooldown_until IS NOT NULL OR pool_status <> 'normal')
    `).run(now);
    return { enabled: Number(result.changes), banned: banned.total };
  }

  listAccountsNeedingReauth(limit = 1_000): string[] {
    const rows = this.db.prepare(`
      SELECT a.id FROM accounts a JOIN account_pool p ON p.account_id = a.id
      WHERE p.enabled = 1
        AND (json_extract(a.payload_json, '$.refresh_invalid') = 1 OR (a.expires_at IS NOT NULL AND a.expires_at <= ?))
        AND (p.sso_reauth_next_at IS NULL OR p.sso_reauth_next_at <= ?)
      ORDER BY COALESCE(a.expires_at, 0), a.id LIMIT ?
    `).all(Date.now(), Date.now(), Math.max(1, Math.min(limit, 5_000))) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  deleteAccount(id: string): boolean {
    return this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes === 1;
  }

  reportPoolSuccess(accountId: string, now = Date.now()): void {
    this.db.prepare(`
      UPDATE account_pool
      SET request_count = request_count + 1, success_count = success_count + 1,
          last_used_at = ?, last_error = NULL, updated_at = ?
      WHERE account_id = ?
    `).run(now, now, accountId);
  }

  reportPoolFailure(accountId: string, error: string, now = Date.now()): void {
    this.db.prepare(`
      UPDATE account_pool
      SET request_count = request_count + 1, fail_count = fail_count + 1,
          last_used_at = ?, last_error = ?, updated_at = ?
      WHERE account_id = ?
    `).run(now, error.slice(0, 1_000), now, accountId);
  }

  private deviceLoginRow(id: string): DeviceLoginSessionRow | null {
    return this.db.prepare("SELECT * FROM device_login_sessions WHERE id = ?").get(id) as DeviceLoginSessionRow | undefined ?? null;
  }
}

interface AccountSummaryRow {
  readonly id: string;
  readonly email: string | null;
  readonly user_id: string | null;
  readonly team_id: string | null;
  readonly expires_at: number | null;
  readonly updated_at: number;
  readonly has_email_mailbox: number;
  readonly enabled: number;
  readonly disabled_for_quota: number;
  readonly disabled_reason: string | null;
  readonly cooldown_until: number | null;
  readonly pool_status: string;
  readonly weight: number;
  readonly request_count: number;
  readonly success_count: number;
  readonly fail_count: number;
  readonly last_used_at: number | null;
  readonly last_error: string | null;
}

interface ApiKeySummaryRow {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly enabled: number;
  readonly note: string;
  readonly created_at: number;
  readonly last_used_at: number | null;
  readonly request_count: number;
  readonly prompt_tokens_total: number;
  readonly completion_tokens_total: number;
  readonly total_tokens_total: number;
  readonly secret_value: string | null;
}

interface UsageTotalsRow {
  readonly requests: number;
  readonly success: number;
  readonly fail: number;
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly cache_read_tokens: number;
}

function usageTotalsFromRow(row: UsageTotalsRow): UsageTotals {
  return {
    requests: row.requests ?? 0,
    success: row.success ?? 0,
    fail: row.fail ?? 0,
    promptTokens: row.prompt_tokens ?? 0,
    completionTokens: row.completion_tokens ?? 0,
    totalTokens: row.total_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
  };
}

function accountSummary(row: AccountSummaryRow): AccountSummary {
  return {
    id: row.id,
    email: row.email,
    userId: row.user_id,
    teamId: row.team_id,
    expiresAt: row.expires_at,
    enabled: row.enabled !== 0,
    disabledForQuota: row.disabled_for_quota !== 0,
    disabledReason: row.disabled_reason,
    cooldownUntil: row.cooldown_until,
    poolStatus: row.pool_status,
    weight: row.weight,
    requestCount: row.request_count,
    successCount: row.success_count,
    failCount: row.fail_count,
    lastUsedAt: row.last_used_at,
    lastError: row.last_error,
    hasEmailMailbox: row.has_email_mailbox !== 0,
    updatedAt: row.updated_at,
  };
}

function apiKeySummary(row: ApiKeySummaryRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    enabled: row.enabled !== 0,
    note: row.note,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    requestCount: row.request_count,
    promptTokensTotal: row.prompt_tokens_total,
    completionTokensTotal: row.completion_tokens_total,
    totalTokensTotal: row.total_tokens_total,
    secret: row.secret_value,
  };
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function chinaDay(epochMilliseconds: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMilliseconds));
  const field = (type: string): string => parts.find((part) => part.type === type)?.value ?? "00";
  return `${field("year")}-${field("month")}-${field("day")}`;
}

function hasNonEmptyString(payload: Record<string, unknown>, key: string): boolean {
  return typeof payload[key] === "string" && payload[key].trim() !== "";
}

function truthy(value: unknown): boolean {
  return value === true
    || value === 1
    || (typeof value === "string" && ["1", "true", "yes"].includes(value.trim().toLowerCase()));
}

function publicDeviceLoginSession(row: DeviceLoginSessionRow): DeviceLoginSession {
  if (!["waiting_user", "running", "succeeded", "failed", "expired"].includes(row.status)) {
    throw new Error(`invalid device login status ${row.status}`);
  }
  return {
    id: row.id,
    status: row.status as DeviceLoginStatus,
    userCode: row.user_code,
    verificationUrl: row.verification_url,
    pollingIntervalMs: row.polling_interval_ms,
    targetAccountId: row.target_account_id,
    accountId: row.account_id,
    email: row.email,
    message: row.message,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    finishedAt: row.finished_at,
  };
}
