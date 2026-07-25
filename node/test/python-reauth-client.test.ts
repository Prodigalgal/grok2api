import assert from "node:assert/strict";
import test from "node:test";

import { PythonReauthClient } from "../src/registration/python-reauth-client.js";

test("Python reauth client returns protocol authentication without exposing account credentials", async () => {
  const client = new PythonReauthClient({
    serviceUrl: "http://127.0.0.1:18070",
    token: "worker-token",
    timeoutMs: 30_000,
    fetchImpl: async (input, init) => {
      if (String(input).endsWith("/health")) return Response.json({ ok: true });
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer worker-token");
      assert.deepEqual(JSON.parse(String(init?.body)), { email: "member@example.test", password: "private-password" });
      return new Response(JSON.stringify({ ok: true, sso: "private-sso", token: { access_token: "private-access", refresh_token: "private-refresh" } }), { status: 200 });
    },
  });
  const result = await client.reauthenticate("member@example.test", "private-password");
  assert.equal(result.sso, "private-sso");
  assert.equal(result.token.access_token, "private-access");
});

test("Python reauth client waits for the sidecar before submitting credentials", async () => {
  let healthChecks = 0;
  let reauthRequests = 0;
  const client = new PythonReauthClient({
    serviceUrl: "http://127.0.0.1:18070",
    token: null,
    timeoutMs: 1_000,
    readinessRetryMs: 1,
    fetchImpl: async (input) => {
      if (String(input).endsWith("/health")) {
        healthChecks += 1;
        if (healthChecks < 3) throw new TypeError("fetch failed");
        return Response.json({ ok: true });
      }
      reauthRequests += 1;
      return Response.json({ sso: "private-sso", token: { access_token: "private-access" } });
    },
  });

  await client.reauthenticate("member@example.test", "private-password");
  assert.equal(healthChecks, 3);
  assert.equal(reauthRequests, 1);
});
