import assert from "node:assert/strict";
import test from "node:test";

import { createApiServer } from "../src/http/health-server.js";

test("Node admin page and static assets are served without exposing an API session", async () => {
  const server = createApiServer();
  const port = await server.listen("127.0.0.1", 0);
  try {
    const root = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/admin");
    const page = await fetch(`http://127.0.0.1:${port}/admin`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="login-form"/);
    assert.match(html, /id="registration-batch-status"/);
    assert.match(html, /id="registration-log"/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/admin/tasks`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/admin/keepalive`)).status, 200);
    const script = await fetch(`http://127.0.0.1:${port}/admin/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    const scriptText = await script.text();
    assert.match(scriptText, /grok2api-registration-batch/);
    assert.match(scriptText, /scheduleRegistrationRefresh/);
  } finally {
    await server.close();
  }
});
