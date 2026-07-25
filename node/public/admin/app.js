const pathTab = location.pathname.split("/").filter(Boolean).at(-1);
const initialTab = ["accounts", "keys", "models", "tasks", "keepalive", "usage", "logs", "settings"].includes(pathTab) ? pathTab : "overview";
const savedRegistrationBatch = (() => {
  try { return JSON.parse(localStorage.getItem("grok2api-registration-batch") || "null"); }
  catch { return null; }
})();
const state = {
  username: sessionStorage.getItem("grok2api-admin-username") || "admin",
  password: sessionStorage.getItem("grok2api-admin-password") || "",
  tab: initialTab,
  accountPage: 1,
  accountProbeResults: {},
  registrationBatch: savedRegistrationBatch,
  registrationTimer: null,
  registrationLoading: false,
  registrationAvailable: false,
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function setConnection(text, kind = "") {
  const node = $("#connection-state");
  node.textContent = text;
  node.className = `state ${kind}`;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("x-admin-username", state.username);
  headers.set("x-admin-password", state.password);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
  return payload;
}

function date(value) {
  return typeof value === "number" && value > 0 ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-";
}

function status(value) {
  const normalized = String(value || "-");
  const kind = /succeeded|normal|active|waiting_user/.test(normalized) ? "good" : /failed|expired|disabled|cancelled/.test(normalized) ? "bad" : "warn";
  const labels = {
    active: "已启用", normal: "正常", disabled: "已停用", quota_disabled: "额度停用", cooldown: "冷却中", expired: "已过期",
    queued: "排队中", leased: "已领取", running: "运行中", waiting_input: "等待输入", waiting_user: "等待授权",
    succeeded: "成功", failed: "失败", cancelled: "已取消",
  };
  return `<span class="status ${kind}">${escapeHtml(labels[normalized] || normalized)}</span>`;
}

function statusBadge(label, kind) {
  return `<span class="status ${kind}">${escapeHtml(label)}</span>`;
}

function accountState(account) {
  const banned = account.lastRenewStatus === "sso_banned" || /banned|suspended|封禁|access denied/i.test(account.disabledReason || "");
  if (banned) return { label: "OAuth 封禁", kind: "bad", detail: "xAI 已拒绝该账号的 OAuth/API 访问" };
  if (!account.enabled) return { label: "手动停用", kind: "bad", detail: account.disabledReason || "账号已由管理员停用" };
  if (account.disabledForQuota) return { label: "额度停用", kind: "warn", detail: account.disabledReason || "账号额度不足，暂不参与请求" };
  if (account.cooldownUntil && account.cooldownUntil > Date.now()) return { label: "冷却中", kind: "warn", detail: `恢复时间：${date(account.cooldownUntil)}` };
  if (account.expiresAt && account.expiresAt <= Date.now()) return { label: "已过期", kind: "bad", detail: "Access Token 已过期，等待自动保活" };
  return { label: "正常", kind: "good", detail: "账号可参与请求调度" };
}

function keepaliveState(account) {
  if (account.lastRenewStatus === "sso_banned" || /banned|suspended|封禁|access denied/i.test(account.disabledReason || "")) {
    return { label: "已停止", kind: "bad", detail: "确认封禁后不再自动重试" };
  }
  const taskIsCurrent = account.reauthTaskUpdatedAt && (!account.lastRenewAt || account.reauthTaskUpdatedAt >= account.lastRenewAt);
  if (taskIsCurrent && ["running", "leased"].includes(account.reauthTaskStatus)) return { label: "重授权中", kind: "warn", detail: `任务更新：${date(account.reauthTaskUpdatedAt)}` };
  if ((taskIsCurrent && account.reauthTaskStatus === "queued") || account.lastRenewStatus === "sso_queued") return { label: "等待重授权", kind: "warn", detail: "已进入独立保活队列" };
  if ((taskIsCurrent && account.reauthTaskStatus === "failed") || account.lastRenewStatus === "sso_failed") {
    const retry = account.ssoReauthNextAt ? `；下次尝试：${date(account.ssoReauthNextAt)}` : "";
    return { label: "重授权失败", kind: "bad", detail: `${localizedReason(account.ssoReauthError || account.lastError)}${retry}` };
  }
  if (account.lastRenewStatus === "invalid") return { label: "刷新令牌失效", kind: "bad", detail: localizedReason(account.lastError) };
  if (account.lastRenewStatus === "ok") return { label: "续期成功", kind: "good", detail: `最近续期：${date(account.lastRenewAt)}` };
  if (account.expiresAt && account.expiresAt <= Date.now()) return { label: "等待续期", kind: "warn", detail: account.ssoReauthNextAt ? `下次尝试：${date(account.ssoReauthNextAt)}` : "等待自动保活调度" };
  return { label: "无需续期", kind: "good", detail: account.lastRenewAt ? `最近检查：${date(account.lastRenewAt)}` : "Token 当前有效" };
}

function localizedReason(value) {
  const reason = String(value || "").trim();
  if (!reason) return "暂无失败原因";
  if (/access denied/i.test(reason)) return "xAI 拒绝 OAuth/API 访问";
  if (/saved SSO cookie is no longer valid/i.test(reason)) return "已保存的登录会话失效";
  if (/refresh token.*revoked|refresh token is invalid/i.test(reason)) return "刷新令牌已撤销或失效";
  if (/account email was not found/i.test(reason)) return "临时邮箱服务中未找到该账号";
  if (/fetch failed|worker is unavailable/i.test(reason)) return "保活服务暂时不可用";
  if (/timed out|timeout/i.test(reason)) return "保活请求超时";
  if (/account is not eligible for probing/i.test(reason)) return "账号缺少可用访问令牌，无法测活";
  if (/running keepalive task/i.test(reason)) return "账号正在执行保活任务，请稍后再删除";
  return reason;
}

function relativeExpiry(value) {
  if (!(typeof value === "number" && value > 0)) return "未提供有效期";
  const delta = value - Date.now();
  const absolute = Math.abs(delta);
  const unit = absolute >= 86_400_000 ? `${Math.floor(absolute / 86_400_000)} 天` : absolute >= 3_600_000 ? `${Math.floor(absolute / 3_600_000)} 小时` : `${Math.max(1, Math.floor(absolute / 60_000))} 分钟`;
  return delta > 0 ? `剩余 ${unit}` : `已过期 ${unit}`;
}

function statusCell(value) {
  return `<div class="account-status">${statusBadge(value.label, value.kind)}<small>${escapeHtml(value.detail)}</small></div>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (item) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[item]));
}

function summary(value, labels) {
  return Object.entries(labels).map(([key, label]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value?.[key] ?? 0)}</strong></div>`).join("");
}

function showTab(tab) {
  state.tab = tab;
  $$("[data-tab]").forEach((node) => node.classList.toggle("active", node.dataset.tab === tab));
  $$("[data-panel]").forEach((node) => node.classList.toggle("active", node.dataset.panel === tab));
  if (tab !== "tasks" && state.registrationTimer) { clearTimeout(state.registrationTimer); state.registrationTimer = null; }
  void loadTab();
}

async function loadOverview() {
  const data = await api("/admin/api/status");
  const metrics = [
    ["账号", data.accounts?.account_count || 0], ["可用", data.accounts?.active_count || 0],
    ["API Key", data.keys?.enabled || 0], ["模型", data.models_count || 0],
  ];
  $("#overview-grid").innerHTML = metrics.map(([name, value]) => `<div class="metric"><span>${escapeHtml(name)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  $("#pool-summary").innerHTML = summary(data.pool, { total: "总数", live: "可用", banned: "OAuth 封禁", disabled: "停用", quotaDisabled: "额度停用", cooldown: "冷却", expired: "过期" });
  $("#usage-summary").innerHTML = summary(data.usage?.today || data.usage, { requests: "今日请求", success: "成功", fail: "失败", totalTokens: "今日 Token" });
  setConnection(data.direct_xai?.configured ? "已连接" : "缺少上游", data.direct_xai?.configured ? "ready" : "error");
}

async function loadConnection() {
  const data = await api("/admin/api/status");
  setConnection(data.direct_xai?.configured ? "已连接" : "缺少上游", data.direct_xai?.configured ? "ready" : "error");
}

async function loadAccounts() {
  const query = new URLSearchParams({ page: String(state.accountPage), page_size: "25" });
  const q = $("#account-query").value.trim();
  const filter = $("#account-status").value;
  if (q) query.set("q", q);
  if (filter) query.set("status", filter);
  const data = await api(`/admin/api/accounts?${query}`);
  $("#accounts-body").innerHTML = data.accounts.map((account) => { const accountStatus = accountState(account); const keepaliveStatus = keepaliveState(account); const probe = state.accountProbeResults[account.id]; return `<tr>
    <td><strong>${escapeHtml(account.email || account.id)}</strong><br><small>${escapeHtml(account.id)}</small></td>
    <td>${statusCell(accountStatus)}</td>
    <td>${statusCell(keepaliveStatus)}${account.renewFailCount ? `<small class="failure-count">累计失败 ${account.renewFailCount} 次</small>` : ""}</td>
    <td><strong>${account.requestCount}</strong><small class="cell-detail">成功 ${account.successCount} / 失败 ${account.failCount}</small></td>
    <td><strong>${date(account.expiresAt)}</strong><small class="cell-detail ${account.expiresAt && account.expiresAt <= Date.now() ? "bad-text" : ""}">${escapeHtml(relativeExpiry(account.expiresAt))}</small></td>
    <td>${date(account.lastUsedAt)}<small class="cell-detail">状态更新：${date(account.updatedAt)}</small></td>
    <td><div class="row-actions"><button type="button" class="quiet" data-account-probe="${escapeHtml(account.id)}">测活</button><button type="button" data-account-toggle="${escapeHtml(account.id)}" data-enabled="${account.enabled}">${account.enabled ? "停用" : "启用"}</button><button type="button" class="danger" data-account-delete="${escapeHtml(account.id)}" data-account-name="${escapeHtml(account.email || account.id)}">删除</button></div>${probe ? `<small class="account-action-result ${probe.ok ? "good-text" : "bad-text"}">${escapeHtml(probe.message)}</small>` : ""}</td>
  </tr>`; }).join("") || `<tr><td colspan="7">没有匹配账号</td></tr>`;
  $("#account-pagination").innerHTML = `<button type="button" ${data.page <= 1 ? "disabled" : ""} id="page-prev">上一页</button><span>${data.page || 0} / ${data.totalPages || 0}，共 ${data.total || 0} 个</span><button type="button" ${data.page >= data.totalPages ? "disabled" : ""} id="page-next">下一页</button>`;
  $("#page-prev")?.addEventListener("click", () => { state.accountPage -= 1; void loadAccounts(); });
  $("#page-next")?.addEventListener("click", () => { state.accountPage += 1; void loadAccounts(); });
  $$('[data-account-toggle]').forEach((button) => button.addEventListener("click", async () => {
    await api(`/admin/api/accounts/${encodeURIComponent(button.dataset.accountToggle)}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: button.dataset.enabled !== "true" }) });
    await loadAccounts();
  }));
  $$('[data-account-probe]').forEach((button) => button.addEventListener("click", async () => {
    const id = button.dataset.accountProbe;
    button.disabled = true;
    button.textContent = "测活中…";
    try {
      await api("/admin/api/accounts/probe", { method: "POST", body: JSON.stringify({ id }) });
      state.accountProbeResults[id] = { ok: true, message: "测活成功" };
      setConnection("账号测活成功", "ready");
    } catch (error) {
      state.accountProbeResults[id] = { ok: false, message: `测活失败：${localizedReason(error.message)}` };
      setConnection("账号测活失败", "error");
    }
    await loadAccounts();
  }));
  $$('[data-account-delete]').forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.accountDelete;
    const name = button.dataset.accountName;
    dialog("删除账号", `<p class="confirmation-copy">确定删除账号 <strong>${escapeHtml(name)}</strong>？账号凭据、池状态和请求统计将永久删除，此操作无法撤销。</p>`, async () => {
      const result = await api("/admin/api/accounts/delete", { method: "POST", body: JSON.stringify({ id }) });
      delete state.accountProbeResults[id];
      setConnection(result.cancelled_tasks ? `账号已删除，同时取消 ${result.cancelled_tasks} 个保活任务` : "账号已删除", "ready");
    });
  }));
}

async function loadKeys() {
  const data = await api("/admin/api/keys");
  $("#keys-body").innerHTML = data.keys.map((key) => `<tr><td>${escapeHtml(key.name)}</td><td><div class="secret-field"><input type="password" readonly value="${escapeHtml(key.secret || "")}" placeholder="${key.secret ? "" : "旧密钥需轮换"}"><button type="button" class="icon-button" data-key-reveal title="显示或隐藏密钥" aria-label="显示或隐藏密钥">&#128065;</button></div></td><td>${status(key.enabled ? "active" : "disabled")}</td><td>${key.requestCount}</td><td>${key.totalTokensTotal}</td><td><div class="row-actions"><button type="button" data-key-toggle="${escapeHtml(key.id)}" data-enabled="${key.enabled}">${key.enabled ? "停用" : "启用"}</button><button type="button" data-key-rotate="${escapeHtml(key.id)}">轮换</button></div></td></tr>`).join("") || `<tr><td colspan="6">没有 API Key</td></tr>`;
  $$('[data-key-reveal]').forEach((button) => button.addEventListener("click", () => { const input = button.previousElementSibling; input.type = input.type === "password" ? "text" : "password"; }));
  $$('[data-key-toggle]').forEach((button) => button.addEventListener("click", async () => { await api(`/admin/api/keys/${encodeURIComponent(button.dataset.keyToggle)}`, { method: "PATCH", body: JSON.stringify({ enabled: button.dataset.enabled !== "true" }) }); await loadKeys(); }));
  $$('[data-key-rotate]').forEach((button) => button.addEventListener("click", async () => { const data = await api(`/admin/api/keys/${encodeURIComponent(button.dataset.keyRotate)}/regenerate`, { method: "POST" }); showSecret(data.secret); await loadKeys(); }));
}

async function loadTasks() {
  if (state.registrationLoading) return;
  state.registrationLoading = true;
  try {
  const [data, availability] = await Promise.all([api("/admin/api/automation/tasks?limit=100"), api("/admin/api/accounts/register/availability")]);
  const tasks = data.tasks.filter((task) => task.kind === "registration");
  $("#registration-domain").value = availability.defaults?.mail_domain || "未配置";
  const maxConcurrency = Number(availability.defaults?.max_concurrency || 1);
  $("#registration-concurrency").max = String(maxConcurrency);
  state.registrationAvailable = Boolean(availability.ok);
  $("#registration-availability").className = `status ${availability.ok ? "good" : "bad"}`;
  $("#registration-availability").textContent = availability.ok ? "注册服务可用" : "注册服务未配置";
  $("#registration-start").disabled = !state.registrationAvailable;
  if (!$("#registration-count").dataset.ready) {
    $("#registration-count").value = localStorage.getItem("grok2api-registration-count") || "1";
    $("#registration-concurrency").value = localStorage.getItem("grok2api-registration-concurrency") || "1";
    $("#registration-count").dataset.ready = "true";
  }

  const batchIds = Array.isArray(state.registrationBatch?.ids) ? state.registrationBatch.ids : [];
  let batchTasks = batchIds.map((id) => tasks.find((task) => task.id === id)).filter(Boolean);
  if (!batchTasks.length) {
    const active = tasks.filter((task) => ["queued", "leased", "running"].includes(task.status));
    if (active.length) {
      batchTasks = active;
      state.registrationBatch = {
        ids: active.map((task) => task.id),
        startedAt: Math.min(...active.map((task) => task.createdAt)),
        targetCount: active.reduce((total, task) => total + Number(task.batch?.count || 1), 0),
        concurrency: Number(active[0]?.batch?.concurrency || 1),
      };
      localStorage.setItem("grok2api-registration-batch", JSON.stringify(state.registrationBatch));
    }
  }
  await renderRegistrationBatch(batchTasks);

  $("#tasks-body").innerHTML = tasks.map((task, index) => `<tr><td><strong>#${tasks.length - index}</strong><br><small>${escapeHtml(task.id.slice(0, 8))} · ${escapeHtml(task.batch?.count || 1)} 个 / 并发 ${escapeHtml(task.batch?.concurrency || 1)}</small></td><td>${registrationStatus(task.status)}</td><td>${task.attempts}</td><td>${date(task.createdAt)}</td><td>${date(task.updatedAt)}</td><td><div class="row-actions"><button type="button" class="quiet" data-task-detail="${escapeHtml(task.id)}">日志</button>${["queued", "running"].includes(task.status) ? `<button type="button" class="danger" data-task-cancel="${escapeHtml(task.id)}">停止</button>` : ""}</div></td></tr>`).join("") || `<tr><td colspan="6">暂无注册任务</td></tr>`;
  $$('[data-task-cancel]').forEach((button) => button.addEventListener("click", async () => { await api(`/admin/api/automation/tasks/${encodeURIComponent(button.dataset.taskCancel)}/cancel`, { method: "POST" }); await loadTasks(); }));
  $$('[data-task-detail]').forEach((button) => button.addEventListener("click", () => void showTaskDetail(button.dataset.taskDetail)));
  scheduleRegistrationRefresh(batchTasks.some((task) => ["queued", "leased", "running"].includes(task.status)) ? 2000 : 5000);
  } finally { state.registrationLoading = false; }
}

function scheduleRegistrationRefresh(delay) {
  if (state.registrationTimer) clearTimeout(state.registrationTimer);
  if (state.tab !== "tasks" || $("#app-view").hidden) return;
  state.registrationTimer = setTimeout(() => void loadTasks(), delay);
}

function taskMessage(event) {
  return event?.detail?.message || event?.detail?.error || event?.type || "等待 Worker 处理";
}

function registrationStatus(value) {
  const labels = { queued: "排队中", leased: "正在领取", running: "执行中", waiting_input: "等待输入", succeeded: "成功", failed: "失败", cancelled: "已停止" };
  const kind = value === "succeeded" ? "good" : ["failed", "cancelled"].includes(value) ? "bad" : "warn";
  return `<span class="status ${kind}">${escapeHtml(labels[value] || value)}</span>`;
}

async function renderRegistrationBatch(tasks) {
  const labels = { queued: "排队中", leased: "正在领取", running: "注册中", succeeded: "已完成", failed: "失败", cancelled: "已停止" };
  if (!tasks.length) {
    $("#registration-metrics").innerHTML = [["总任务", 0], ["等待", 0], ["执行中", 0], ["成功", 0], ["失败/停止", 0]].map(([name, value]) => `<div><span>${name}</span><strong>${value}</strong></div>`).join("");
    $("#registration-batch-meta").textContent = "尚未启动批次";
    $("#registration-batch-status").textContent = "空闲";
    $("#registration-batch-status").className = "status";
    $("#registration-current-step").textContent = "等待启动";
    $("#registration-elapsed").textContent = "-";
    $("#registration-progress-bar").style.width = "0%";
    $("#registration-log").innerHTML = '<div class="registration-log-empty">任务启动后，这里会显示实际执行日志。</div>';
    $("#registration-stop").disabled = true;
    return;
  }

  const startedAt = state.registrationBatch?.startedAt || Math.min(...tasks.map((task) => task.createdAt));
  const active = tasks.find((task) => ["leased", "running"].includes(task.status)) || tasks.find((task) => task.status === "queued") || tasks.at(-1);
  const details = active ? await api(`/admin/api/automation/tasks/${encodeURIComponent(active.id)}`).catch(() => ({ events: [] })) : { events: [] };
  const events = details.events || [];
  const latest = events.at(-1);
  const progressEvent = [...events].reverse().find((event) => Number.isFinite(Number(event.detail?.targetCount)));
  const result = active?.result || {};
  const targetCount = Number(progressEvent?.detail?.targetCount || result.targetCount || state.registrationBatch?.targetCount || tasks.reduce((total, task) => total + Number(task.batch?.count || 1), 0));
  const concurrency = Number(progressEvent?.detail?.concurrency || result.concurrency || state.registrationBatch?.concurrency || active?.batch?.concurrency || 1);
  const legacyBatch = tasks.length > 1;
  const successCount = Number(progressEvent?.detail?.successCount ?? result.successCount ?? (legacyBatch ? tasks.filter((task) => task.status === "succeeded").length : active?.status === "succeeded" ? targetCount : 0));
  const failedCount = Number(progressEvent?.detail?.failedCount ?? result.failedCount ?? (legacyBatch ? tasks.filter((task) => ["failed", "cancelled"].includes(task.status)).length : active?.status === "failed" ? targetCount : 0));
  const runningCount = Number(progressEvent?.detail?.running ?? (tasks.some((task) => ["leased", "running"].includes(task.status)) ? Math.min(concurrency, Math.max(0, targetCount - successCount - failedCount)) : 0));
  const waitingCount = Math.max(0, targetCount - successCount - failedCount - runningCount);
  $("#registration-metrics").innerHTML = [["总任务", targetCount], ["等待", waitingCount], ["执行中", runningCount], ["成功", successCount], ["失败/停止", failedCount]].map(([name, value]) => `<div><span>${name}</span><strong>${value}</strong></div>`).join("");
  const allDone = tasks.every((task) => ["succeeded", "failed", "cancelled"].includes(task.status));
  const elapsedUntil = allDone ? Math.max(...tasks.map((task) => task.finishedAt || task.updatedAt)) : Date.now();
  const batchState = allDone ? (failedCount ? "已结束" : "已完成") : runningCount ? "执行中" : "排队中";
  $("#registration-batch-meta").textContent = `${new Date(startedAt).toLocaleString("zh-CN", { hour12: false })} · ${targetCount} 个任务 · 并发 ${concurrency}`;
  $("#registration-batch-status").textContent = batchState;
  $("#registration-batch-status").className = `status ${allDone ? (failedCount ? "bad" : "good") : "warn"}`;
  $("#registration-current-step").textContent = latest ? taskMessage(latest) : labels[active?.status] || "等待 Worker 处理";
  $("#registration-elapsed").textContent = `${Math.max(0, Math.floor((elapsedUntil - startedAt) / 1000))} 秒`;
  $("#registration-progress-bar").style.width = `${targetCount ? Math.round((successCount + failedCount) / targetCount * 100) : 0}%`;
  $("#registration-stop").disabled = allDone;
  const logRows = events.map((event) => `<div class="registration-log-line"><time>${new Date(event.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}</time><span>${escapeHtml(event.type)}</span><strong>${escapeHtml(taskMessage(event))}</strong></div>`);
  if (active?.error && !events.some((event) => taskMessage(event) === active.error)) logRows.push(`<div class="registration-log-line error"><time>${new Date(active.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}</time><span>error</span><strong>${escapeHtml(active.error)}</strong></div>`);
  $("#registration-log").innerHTML = logRows.join("") || `<div class="registration-log-empty">${escapeHtml(labels[active?.status] || "等待 Worker 处理")}</div>`;
  $("#registration-log").scrollTop = $("#registration-log").scrollHeight;
}

function showRegistrationNotice(message, kind = "") {
  const notice = $("#registration-notice");
  notice.hidden = false;
  notice.textContent = message;
  notice.className = `registration-notice ${kind}`;
}

async function loadKeepalive() {
  const data = await api("/admin/api/maintainer");
  const pool = data.pool || {};
  $("#keepalive-metrics").innerHTML = [["账号总数", pool.total || 0], ["已启用", pool.enabled || 0], ["可用", pool.live || 0], ["已过期", pool.expired || 0]].map(([name, value]) => `<div class="metric"><span>${name}</span><strong>${value}</strong></div>`).join("");
  $("#reauth-summary").innerHTML = summary(data.reauth, { workers: "独立线程", queued: "等待", running: "处理中", failed24h: "近 24h 失败" });
  $("#reauth-failures").innerHTML = (data.reauth?.failures || []).length
    ? `<h3>近期失败原因</h3>${data.reauth.failures.map((item) => `<div class="reauth-failure"><span title="${escapeHtml(item.reason)}">${escapeHtml(item.reason)}</span><strong>${escapeHtml(item.count)}</strong></div>`).join("")}`
    : "";
}

async function loadModels() {
  const data = await api("/admin/api/models");
  $("#models-body").innerHTML = (data.data || []).map((model) => `<tr><td><strong>${escapeHtml(model.id)}</strong></td><td>${escapeHtml(model.name || "-")}</td><td>${escapeHtml(model.owned_by || "xai")}</td><td>${escapeHtml(model.context_window || "-")}</td><td>${model.supports_reasoning_effort ? status("active") : "-"}</td></tr>`).join("") || `<tr><td colspan="5">暂无模型</td></tr>`;
}

async function loadUsage() {
  const [summaryData, seriesData, modelData] = await Promise.all([
    api("/admin/api/usage/summary"),
    api("/admin/api/usage/series?days=14"),
    api("/admin/api/usage/by-model"),
  ]);
  const total = summaryData.total || {};
  const today = summaryData.today || {};
  const metrics = [["今日请求", today.requests || 0], ["今日 Token", today.totalTokens || 0], ["累计请求", total.requests || 0], ["累计 Token", total.totalTokens || 0]];
  $("#usage-metrics").innerHTML = metrics.map(([name, value]) => `<div class="metric"><span>${escapeHtml(name)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  $("#usage-series").innerHTML = compactTable(["日期", "请求", "成功", "Token"], (seriesData.series || []).map((row) => [row.day, row.requests, row.success, row.totalTokens]));
  $("#usage-models").innerHTML = compactTable(["模型", "请求", "成功", "Token"], (modelData.items || []).map((row) => [row.id, row.requests, row.success, row.totalTokens]));
}

async function loadLogs() {
  const data = await api("/admin/api/logs?limit=200");
  $("#logs-body").innerHTML = (data.logs || []).map((entry) => `<tr><td>${date(entry.createdAt)}</td><td>${escapeHtml(entry.type)}</td><td>${status(entry.status)}</td><td><code class="inline-detail">${escapeHtml(entry.detail?.error || entry.detail?.message || "-")}</code></td></tr>`).join("") || `<tr><td colspan="4">暂无运行日志</td></tr>`;
}

async function loadSettings() {
  const data = await api("/admin/api/settings");
  $("#setting-default-model").value = data.settings?.default_model || data.runtime?.default_model || "grok-4.5";
  $("#setting-account-mode").value = data.settings?.account_mode || "round_robin";
}

function compactTable(headers, rows) {
  return `<table class="compact-table"><thead><tr>${headers.map((name) => `<th>${escapeHtml(name)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${headers.length}">暂无数据</td></tr>`}</tbody></table>`;
}

async function showTaskDetail(id) {
  const data = await api(`/admin/api/automation/tasks/${encodeURIComponent(id)}`);
  const rows = data.events.map((event) => `<tr><td>${date(event.createdAt)}</td><td>${escapeHtml(event.type)}</td><td>${escapeHtml(event.detail?.message || event.detail?.error || "-")}</td></tr>`).join("") || `<tr><td colspan="3">暂无日志</td></tr>`;
  dialog("注册日志详情", `<div class="task-facts"><span>任务</span><strong>${escapeHtml(data.task.kind)}</strong><span>状态</span><strong>${escapeHtml(data.task.status)}</strong><span>错误</span><strong>${escapeHtml(data.task.error || "-")}</strong></div><div class="table-wrap"><table><thead><tr><th>时间</th><th>事件</th><th>详情</th></tr></thead><tbody>${rows}</tbody></table></div>`, async () => {});
}

async function loadTab() {
  try {
    if (state.tab === "overview") await loadOverview();
    if (state.tab === "accounts") await loadAccounts();
    if (state.tab === "keys") await loadKeys();
    if (state.tab === "models") await loadModels();
    if (state.tab === "tasks") await loadTasks();
    if (state.tab === "keepalive") await loadKeepalive();
    if (state.tab === "usage") await loadUsage();
    if (state.tab === "logs") await loadLogs();
    if (state.tab === "settings") await loadSettings();
  } catch (error) { setConnection(error.message || "连接失败", "error"); }
}

function dialog(title, fields, submit) {
  $("#dialog-title").textContent = title;
  $("#dialog-fields").innerHTML = fields;
  $("#dialog-error").hidden = true;
  const form = $("#dialog-form");
  const close = () => $("#form-dialog").close();
  $("#dialog-close").onclick = close;
  form.onsubmit = async (event) => {
    event.preventDefault();
    try { await submit(new FormData(form)); close(); await loadTab(); }
    catch (error) { const message = $("#dialog-error"); message.textContent = error.message || "操作失败"; message.hidden = false; }
  };
  $("#form-dialog").showModal();
}

function showSecret(secret) {
  $("#issued-secret").textContent = secret;
  $("#secret-dialog").showModal();
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.username = $("#admin-username").value.trim();
  state.password = $("#admin-password").value;
  try {
    const status = await api("/admin/api/status");
    sessionStorage.setItem("grok2api-admin-username", state.username);
    sessionStorage.setItem("grok2api-admin-password", state.password);
    setConnection(status.direct_xai?.configured ? "已连接" : "缺少上游", status.direct_xai?.configured ? "ready" : "error");
    $("#login-view").hidden = true; $("#app-view").hidden = false; showTab(state.tab);
  } catch (error) { const message = $("#login-error"); message.textContent = error.message || "认证失败"; message.hidden = false; }
});
$("#logout-button").addEventListener("click", () => { sessionStorage.removeItem("grok2api-admin-username"); sessionStorage.removeItem("grok2api-admin-password"); state.password = ""; $("#app-view").hidden = true; $("#login-view").hidden = false; setConnection("未连接"); });
$("#refresh-button").addEventListener("click", () => { void loadConnection(); void loadTab(); });
$$('[data-tab]').forEach((button) => button.addEventListener("click", () => showTab(button.dataset.tab)));
$("#account-search").addEventListener("click", () => { state.accountPage = 1; void loadAccounts(); });
$("#key-create").addEventListener("click", () => dialog("创建 API Key", `<label>名称<input name="name" required maxlength="120"></label><label>备注<input name="note" maxlength="1000"></label>`, async (form) => { const data = await api("/admin/api/keys", { method: "POST", body: JSON.stringify({ name: form.get("name"), note: form.get("note") }) }); showSecret(data.secret); }));
$("#registration-save").addEventListener("click", () => { localStorage.setItem("grok2api-registration-count", $("#registration-count").value); localStorage.setItem("grok2api-registration-concurrency", $("#registration-concurrency").value); setConnection("注册设置已保存", "ready"); });
$("#registration-start").addEventListener("click", async () => {
  const button = $("#registration-start");
  const count = Number($("#registration-count").value);
  const concurrency = Number($("#registration-concurrency").value);
  button.disabled = true; button.textContent = "正在提交…";
  showRegistrationNotice(`正在提交 ${count} 个注册任务…`, "pending");
  try {
    localStorage.setItem("grok2api-registration-count", String(count));
    localStorage.setItem("grok2api-registration-concurrency", String(concurrency));
    const data = await api("/admin/api/accounts/register", { method: "POST", body: JSON.stringify({ count, concurrency }) });
    state.registrationBatch = { ids: data.tasks.map((task) => task.id), startedAt: Math.min(...data.tasks.map((task) => task.createdAt)), targetCount: data.count, concurrency: data.concurrency };
    localStorage.setItem("grok2api-registration-batch", JSON.stringify(state.registrationBatch));
    showRegistrationNotice(`批次已提交：共 ${data.count} 个，并发 ${data.concurrency}。`, "success");
    await loadTasks();
  } catch (error) { showRegistrationNotice(error.message || "任务提交失败", "error"); }
  finally { button.textContent = "启动批量注册"; button.disabled = !state.registrationAvailable; }
});
$("#registration-stop").addEventListener("click", async () => {
  const data = await api("/admin/api/automation/tasks?limit=500");
  const active = data.tasks.filter((item) => item.kind === "registration" && ["queued", "leased", "running"].includes(item.status));
  showRegistrationNotice(`正在停止 ${active.length} 个任务…`, "pending");
  for (const task of active) await api(`/admin/api/automation/tasks/${encodeURIComponent(task.id)}/cancel`, { method: "POST" }).catch(() => undefined);
  showRegistrationNotice("停止请求已提交。", "success");
  await loadTasks();
});
$("#registration-refresh").addEventListener("click", () => void loadTasks());
$("#keepalive-run").addEventListener("click", async () => { await api("/admin/api/maintainer/run", { method: "POST" }); await loadKeepalive(); });
$("#keepalive-enable-all").addEventListener("click", async () => { const result = await api("/admin/api/accounts/enable-all", { method: "POST", body: "{}" }); setConnection(`已启用 ${result.enabled} 个，重授权排队 ${result.queued} 个`, "ready"); await loadKeepalive(); });
$("#models-sync").addEventListener("click", async () => { await api("/admin/api/models/sync", { method: "POST" }); await loadModels(); });
$("#logs-refresh").addEventListener("click", () => void loadLogs());
$("#maintainer-run").addEventListener("click", async () => { await api("/admin/api/maintainer/run", { method: "POST" }); await loadAccounts(); });
$("#account-export").addEventListener("click", async () => {
  const payload = await api("/admin/api/accounts/export");
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "auth.json"; link.click(); URL.revokeObjectURL(url);
});
$("#account-import").addEventListener("click", () => dialog("导入账号 JSON", `<label>auth.json 内容<textarea name="payload" required placeholder='{ "auth": { ... } }'></textarea></label>`, async (form) => {
  const payload = JSON.parse(String(form.get("payload") || "{}"));
  await api("/admin/api/accounts/import", { method: "POST", body: JSON.stringify(payload) });
}));
$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await api("/admin/api/settings", { method: "PATCH", body: JSON.stringify({ settings: { default_model: $("#setting-default-model").value.trim(), account_mode: $("#setting-account-mode").value } }) });
  setConnection("设置已保存", "ready");
});
$("#copy-secret").addEventListener("click", async () => { await navigator.clipboard.writeText($("#issued-secret").textContent || ""); });

$("#admin-username").value = state.username;
if (state.password) { $("#admin-password").value = state.password; $("#login-form").requestSubmit(); }
