import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("Node runtime requires an explicit direct xAI upstream and uses only Cloudflare Temp Mail settings", () => {
  const config = loadConfig({
    GROK_CLI_CHAT_PROXY_BASE_URL: "https://legacy-cpa.example.test/v1",
    GROK2API_CFMAIL_BASE_URL: "https://mail.example.test/",
    GROK2API_CFMAIL_API_KEY: "private-password",
    GROK2API_CFMAIL_DOMAIN: "mail.example.test",
  });
  assert.equal(config.upstreamBase, null);
  assert.equal(config.cfMailBaseUrl, "https://mail.example.test/");
  assert.equal(config.cfMailAdminPassword, "private-password");
  assert.equal(config.cfMailDomain, "mail.example.test");

  const direct = loadConfig({ GROK2API_XAI_UPSTREAM_BASE_URL: "https://direct-xai.example.test/v1/" });
  assert.equal(direct.upstreamBase, "https://direct-xai.example.test/v1");
});

test("automation worker is enabled by default and can be disabled for a shadow runtime", () => {
  assert.equal(loadConfig({}).automationWorkerEnabled, true);
  assert.equal(loadConfig({ GROK2API_AUTOMATION_WORKER: "0" }).automationWorkerEnabled, false);
  assert.equal(loadConfig({}).reauthWorkers, 4);
  assert.equal(loadConfig({ GROK2API_REAUTH_WORKERS: "6" }).reauthWorkers, 6);
  assert.equal(loadConfig({}).registrationMaxConcurrency, 3);
  assert.equal(loadConfig({ GROK2API_REGISTRATION_MAX_CONCURRENCY: "5" }).registrationMaxConcurrency, 5);
});
