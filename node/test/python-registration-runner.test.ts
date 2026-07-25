import assert from "node:assert/strict";
import test from "node:test";

import { PythonRegistrationTaskRunner } from "../src/registration/python-registration-runner.js";

test("Python registration worker returns SSO to Node over direct egress", async () => {
  let savedMailbox: Record<string, unknown> | null = null;
  const runner = new PythonRegistrationTaskRunner({
    serviceUrl: "http://127.0.0.1:18070",
    token: "worker-token",
    timeoutMs: 60_000,
    cfMailBaseUrl: "https://mail.example.test",
    cfMailAdminPassword: "mail-admin-password",
    cfMailDomain: "mail.example.test",
    ssoConverter: {
      async registerFromSsoCookie(sso, email, token) {
        assert.equal(sso, "private-sso");
        assert.equal(email, "new@mail.example.test");
        assert.equal(token?.access_token, "private-access-token");
        return { accountId: "account-1", email };
      },
    },
    mailboxStore: {
      saveCloudflareMailboxCredential(accountId, mailbox) {
        savedMailbox = { accountId, ...mailbox };
      },
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer worker-token");
      if (url.endsWith("/internal/registration/v1/jobs")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.proxy, "");
        assert.equal(body.count, 1);
        assert.equal(body.concurrency, 1);
        return Response.json({ id: "session-1", status: "queued" });
      }
      if (url.includes("/sessions/session-1?include_auth_json=1")) {
        return Response.json({
          id: "session-1",
          status: "completed",
          auth_json: {
            external_registration: {
              sso: "private-sso",
              token: { access_token: "private-access-token", refresh_token: "private-refresh-token" },
              email: "new@mail.example.test",
              mailbox: { id: "mailbox-1", address: "new@mail.example.test", access_token: "private-mailbox-token" },
            },
          },
        });
      }
      throw new Error(`unexpected registration worker request ${url}`);
    },
  });

  const result = await runner.run({ mailbox: { domain: "mail.example.test" } });
  assert.deepEqual(result, {
    accountId: "account-1",
    email: "new@mail.example.test",
    mailProvider: "cloudflare_temp_mail",
    executor: "python_registration_worker",
    targetCount: 1,
    concurrency: 1,
    successCount: 1,
    failedCount: 0,
  });
  assert.deepEqual(savedMailbox, {
    accountId: "account-1",
    id: "mailbox-1",
    address: "new@mail.example.test",
    accessToken: "private-mailbox-token",
  });
});

test("Python registration worker delegates lazy batch concurrency and persists every account", async () => {
  let batchPolls = 0;
  const converted: string[] = [];
  const events: Array<{ type: string; detail?: Readonly<Record<string, unknown>> }> = [];
  const runner = new PythonRegistrationTaskRunner({
    serviceUrl: "http://127.0.0.1:18070",
    token: null,
    timeoutMs: 60_000,
    cfMailBaseUrl: "https://mail.example.test",
    cfMailAdminPassword: "mail-admin-password",
    cfMailDomain: "mail.example.test",
    ssoConverter: {
      async registerFromSsoCookie(_sso, email) {
        const address = email || "";
        converted.push(address);
        return { accountId: `account-${address}`, email: address };
      },
    },
    mailboxStore: { saveCloudflareMailboxCredential() {} },
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/internal/registration/v1/jobs")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.count, 3);
        assert.equal(body.concurrency, 2);
        return Response.json({ batch: true, batch_id: "batch-1", status: "running" });
      }
      if (url.endsWith("/internal/registration/v1/batches/batch-1")) {
        batchPolls += 1;
        return batchPolls === 1
          ? Response.json({ status: "running", count: 3, imported: 1, error: 0, running: 1, spawned: 2, sessions: [{ id: "session-1", status: "imported" }, { id: "session-2", status: "running" }] })
          : Response.json({ status: "done", count: 3, imported: 3, error: 0, running: 0, spawned: 3, sessions: [{ id: "session-2", status: "imported" }, { id: "session-3", status: "imported" }] });
      }
      const match = url.match(/\/sessions\/(session-\d+)\?include_auth_json=1$/);
      if (match) {
        const email = `${match[1]}@mail.example.test`;
        return Response.json({ status: "imported", auth_json: { external_registration: { sso: `sso-${match[1]}`, token: { access_token: `token-${match[1]}` }, email, mailbox: { id: `mail-${match[1]}`, address: email, access_token: `mail-token-${match[1]}` } } } });
      }
      throw new Error(`unexpected registration worker request ${url}`);
    },
  });

  const result = await runner.run({ count: 3, concurrency: 2 }, { onEvent: (event) => events.push(event) });
  assert.equal(result.targetCount, 3);
  assert.equal(result.concurrency, 2);
  assert.equal(result.successCount, 3);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(converted.sort(), ["session-1@mail.example.test", "session-2@mail.example.test", "session-3@mail.example.test"]);
  assert.equal(events.some((event) => event.type === "worker_batch_progress" && event.detail?.running === 1), true);
});

test("Python registration worker stops a failed direct session", async () => {
  let stopped = 0;
  const runner = new PythonRegistrationTaskRunner({
    serviceUrl: "http://127.0.0.1:18070",
    token: null,
    timeoutMs: 60_000,
    cfMailBaseUrl: "https://mail.example.test",
    cfMailAdminPassword: "mail-admin-password",
    cfMailDomain: "mail.example.test",
    ssoConverter: {
      async registerFromSsoCookie() {
        throw new Error("unexpected SSO conversion");
      },
    },
    mailboxStore: { saveCloudflareMailboxCredential() {} },
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/internal/registration/v1/jobs")) {
        return Response.json({ id: "session-failed", status: "queued" });
      }
      if (url.includes("/sessions/session-failed?include_auth_json=1")) {
        return Response.json({ status: "failed", error: "captcha rejected" });
      }
      if (url.endsWith("/sessions/session-failed/stop")) {
        stopped += 1;
        return Response.json({ status: "stopped" });
      }
      throw new Error(`unexpected registration worker request ${url}`);
    },
  });

  await assert.rejects(() => runner.run({}), /captcha rejected/);
  assert.equal(stopped, 1);
});

test("Python registration persists a pending account when fresh OAuth is not ready", async () => {
  let pending = 0;
  const runner = new PythonRegistrationTaskRunner({
    serviceUrl: "http://127.0.0.1:18070",
    token: null,
    timeoutMs: 60_000,
    cfMailBaseUrl: "https://mail.example.test",
    cfMailAdminPassword: "mail-admin-password",
    cfMailDomain: "mail.example.test",
    ssoConverter: {
      async registerFromSsoCookie() { throw new Error("token path should not run"); },
      async registerPendingAccount(sso, email, password) {
        assert.equal(sso, "pending-sso");
        assert.equal(email, "pending@mail.example.test");
        assert.equal(password, "private-password");
        pending += 1;
        return { accountId: "pending-account", email };
      },
    },
    mailboxStore: { saveCloudflareMailboxCredential() {} },
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/internal/registration/v1/jobs")) return Response.json({ id: "pending-session" });
      if (url.includes("/sessions/pending-session?include_auth_json=1")) return Response.json({
        status: "completed",
        auth_json: { external_registration: {
          sso: "pending-sso",
          token: {},
          email: "pending@mail.example.test",
          password: "private-password",
          mailbox: { id: "mailbox-pending", address: "pending@mail.example.test", access_token: "mailbox-token" },
        } },
      });
      throw new Error(`unexpected URL ${url}`);
    },
  });
  assert.equal((await runner.run({})).accountId, "pending-account");
  assert.equal(pending, 1);
});
