import { mkdirSync } from "node:fs";

import { DeviceLoginService } from "./auth/device-login-service.js";
import { SsoReauthService } from "./auth/sso-reauth-service.js";
import { PlaywrightBrowserTaskRunner } from "./automation/browser-task-runner.js";
import { AutomationTaskWorker, AutomationTaskWorkerPool } from "./automation/task-worker.js";
import { loadConfig } from "./config.js";
import { ChatService } from "./chat/service.js";
import { createApiServer } from "./http/health-server.js";
import { TokenMaintainer } from "./maintainer/service.js";
import { CloudflareRegistrationTaskRunner } from "./registration/cloudflare-registration-runner.js";
import { CloudflareEmailLoginTaskRunner } from "./registration/cloudflare-email-login-runner.js";
import { CloudflareTempMailClient } from "./registration/cloudflare-temp-mail.js";
import { PythonRegistrationTaskRunner } from "./registration/python-registration-runner.js";
import { PythonReauthClient } from "./registration/python-reauth-client.js";
import { SingleInstanceLock } from "./runtime/single-instance-lock.js";
import { SqliteStore } from "./storage/sqlite-store.js";
import { UsageRecorder } from "./usage/recorder.js";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const lock = SingleInstanceLock.acquire(config.dataDir);
const store = new SqliteStore(config.databasePath);
store.migrate();
const storedDefaultModel = store.getSetting("default_model");
const runtimeDefaultModel = typeof storedDefaultModel === "string" && storedDefaultModel.trim() ? storedDefaultModel.trim() : config.defaultModel;
const storedPoolMode = store.getSetting("account_mode");
const runtimePoolMode = storedPoolMode === "least_used" || storedPoolMode === "random" || storedPoolMode === "round_robin" ? storedPoolMode : config.poolMode;
const usageRecorder = new UsageRecorder(store, config.usageFlushIntervalMs, config.usageFlushBatch);
const maintainer = new TokenMaintainer({ store, config });
const deviceLogins = new DeviceLoginService({ store, config });
const ssoReauth = new SsoReauthService({ store, deviceLogins, config });
const browserRunner = new PlaywrightBrowserTaskRunner();
const registrationRunner = config.cfMailBaseUrl && config.cfMailAdminPassword
  ? config.registrationServiceUrl
    ? new PythonRegistrationTaskRunner({
      serviceUrl: config.registrationServiceUrl,
      token: config.registrationServiceToken,
      timeoutMs: config.registrationTimeoutMs,
      cfMailBaseUrl: config.cfMailBaseUrl,
      cfMailAdminPassword: config.cfMailAdminPassword,
      cfMailDomain: config.cfMailDomain,
      ssoConverter: ssoReauth,
      mailboxStore: store,
    })
    : new CloudflareRegistrationTaskRunner(browserRunner, new CloudflareTempMailClient({
    baseUrl: config.cfMailBaseUrl,
    adminPassword: config.cfMailAdminPassword,
    domain: config.cfMailDomain,
  }), ssoReauth, store)
  : null;
const emailLoginRunner = config.cfMailBaseUrl && config.cfMailAdminPassword
  ? new CloudflareEmailLoginTaskRunner(browserRunner, new CloudflareTempMailClient({
    baseUrl: config.cfMailBaseUrl,
    adminPassword: config.cfMailAdminPassword,
    domain: config.cfMailDomain,
  }), store, ssoReauth, config.registrationServiceUrl ? new PythonReauthClient({
    serviceUrl: config.registrationServiceUrl,
    token: config.registrationServiceToken,
    timeoutMs: config.registrationTimeoutMs,
  }) : null)
  : null;
const registrationWorker = new AutomationTaskWorker({
  store,
  ssoReauth,
  browserRunner,
  registrationRunner,
  emailLoginRunner,
  config,
  owner: `node-registration-${process.pid}`,
  kinds: ["registration"],
});
const reauthWorkers = Array.from({ length: config.reauthWorkers }, (_unused, index) => new AutomationTaskWorker({
  store,
  ssoReauth,
  browserRunner,
  registrationRunner,
  emailLoginRunner,
  config,
  owner: `node-reauth-${process.pid}-${index + 1}`,
  kinds: ["sso_reauth", "sso_email_reauth", "browser_automation"],
}));
const taskWorkers = new AutomationTaskWorkerPool([registrationWorker, ...reauthWorkers]);
const server = createApiServer({
  modelStore: store,
  apiKeyStore: store,
  defaultModel: runtimeDefaultModel,
  apiKeyAuth: { legacyApiKey: config.legacyApiKey, requireApiKey: config.requireApiKey },
  chatService: new ChatService(store, config.upstreamBase, runtimeDefaultModel, runtimePoolMode, usageRecorder),
  automationTasks: store.automationTasks(),
  automationWorker: taskWorkers,
  registrationAvailable: config.automationWorkerEnabled && registrationRunner !== null,
  registrationDefaults: {
    mailBaseUrl: config.cfMailBaseUrl,
    mailDomain: config.cfMailDomain,
    maxConcurrency: config.registrationMaxConcurrency,
  },
  reauthConcurrency: config.reauthWorkers,
  adminStore: store,
  adminUsername: config.adminUsername,
  adminPassword: config.adminPassword,
  maintainer,
});

let stopping = false;
async function stop(exitCode: number): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    maintainer.stop();
    taskWorkers.stop();
    usageRecorder.stop();
    await server.close();
  } finally {
    store.close();
    lock.release();
  }
  process.exitCode = exitCode;
}

process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));

await server.listen(config.host, config.port);
if (config.tokenMaintainerEnabled) {
  maintainer.start();
}
if (config.automationWorkerEnabled) {
  taskWorkers.start();
}
usageRecorder.start();
console.info(JSON.stringify({
  event: "node_runtime_started",
  host: config.host,
  port: config.port,
  store: "sqlite",
  automationWorker: config.automationWorkerEnabled,
  tokenMaintainer: config.tokenMaintainerEnabled,
}));
