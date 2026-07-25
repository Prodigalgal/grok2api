import { chromium } from "playwright";

export interface BrowserTaskRunner {
  run(request: Record<string, unknown>, runtime?: BrowserTaskRuntime): Promise<Record<string, unknown>>;
}

export interface SsoCookieCaptureRunner extends BrowserTaskRunner {
  runWithSsoCookie(request: Record<string, unknown>, runtime?: BrowserTaskRuntime): Promise<BrowserSsoCaptureResult>;
}

export interface BrowserSsoCaptureResult {
  readonly result: Record<string, unknown>;
  readonly ssoCookie: string;
}

export interface BrowserTaskRuntime {
  readonly variables?: Readonly<Record<string, string>>;
  readonly waitForMailCode?: () => Promise<string>;
  readonly proxyServer?: string;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: { readonly type: string; readonly message: string; readonly detail?: Readonly<Record<string, unknown>> }) => void;
}

type BrowserAction =
  | { readonly type: "xai_email_login" }
  | { readonly type: "click"; readonly selector: string }
  | { readonly type: "fill"; readonly selector: string; readonly value: string }
  | { readonly type: "press"; readonly selector: string; readonly key: string }
  | { readonly type: "fill_mail_code"; readonly selector: string }
  | { readonly type: "wait_for_selector"; readonly selector: string }
  | { readonly type: "wait_for_url"; readonly url: string };

interface BrowserTaskSpec {
  readonly url: string;
  readonly actions: readonly BrowserAction[];
}

export class PlaywrightBrowserTaskRunner implements BrowserTaskRunner {
  async run(request: Record<string, unknown>, runtime: BrowserTaskRuntime = {}): Promise<Record<string, unknown>> {
    return (await this.runSession(request, runtime, false)).result;
  }

  async runWithSsoCookie(request: Record<string, unknown>, runtime: BrowserTaskRuntime = {}): Promise<BrowserSsoCaptureResult> {
    const output = await this.runSession(request, runtime, true);
    return { result: output.result, ssoCookie: output.ssoCookie ?? "" };
  }

  private async runSession(
    request: Record<string, unknown>,
    runtime: BrowserTaskRuntime,
    captureSso: boolean,
  ): Promise<{ readonly result: Record<string, unknown>; readonly ssoCookie?: string }> {
    const spec = parseSpec(request);
    const browser = await chromium.launch({
      headless: true,
      ...(runtime.proxyServer ? { proxy: { server: runtime.proxyServer } } : {}),
    });
    try {
      runtime.signal?.throwIfAborted();
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(spec.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      for (const action of spec.actions) {
        runtime.signal?.throwIfAborted();
        if (action.type === "xai_email_login") {
          await completeXaiEmailLogin(page, context, runtime);
        } else if (action.type === "click") {
          await page.locator(action.selector).click({ timeout: 30_000 });
        } else if (action.type === "fill") {
          await page.locator(action.selector).fill(resolveTemplate(action.value, runtime.variables), { timeout: 30_000 });
        } else if (action.type === "fill_mail_code") {
          if (!runtime.waitForMailCode) {
            throw new Error("fill_mail_code requires a mailbox runtime");
          }
          await page.locator(action.selector).fill(await runtime.waitForMailCode(), { timeout: 150_000 });
        } else if (action.type === "press") {
          await page.locator(action.selector).press(action.key, { timeout: 30_000 });
        } else if (action.type === "wait_for_selector") {
          await page.locator(action.selector).waitFor({ state: "visible", timeout: 30_000 });
        } else {
          await page.waitForURL(action.url, { timeout: 30_000 });
        }
      }
      const result = { finalUrl: page.url(), title: await page.title() };
      if (!captureSso) {
        return { result };
      }
      const ssoCookie = (await context.cookies())
        .find((cookie) => cookie.name.toLowerCase() === "sso" || cookie.name.toLowerCase() === "sso-rw")?.value ?? "";
      return { result, ssoCookie };
    } finally {
      await browser.close();
    }
  }
}

export function supportsSsoCookieCapture(runner: BrowserTaskRunner): runner is SsoCookieCaptureRunner {
  return typeof (runner as Partial<SsoCookieCaptureRunner>).runWithSsoCookie === "function";
}

function parseSpec(request: Record<string, unknown>): BrowserTaskSpec {
  const raw = request.browser ?? request;
  if (!raw || Array.isArray(raw) || typeof raw !== "object") {
    throw new Error("browser task must include a browser object");
  }
  const object = raw as Record<string, unknown>;
  const url = typeof object.url === "string" ? object.url.trim() : "";
  if (!/^https:\/\//i.test(url)) {
    throw new Error("browser task URL must use https");
  }
  const rawActions = object.actions;
  if (!Array.isArray(rawActions) || rawActions.length > 50) {
    throw new Error("browser task actions must contain at most 50 actions");
  }
  return { url, actions: rawActions.map(parseAction) };
}

function parseAction(raw: unknown): BrowserAction {
  if (!raw || Array.isArray(raw) || typeof raw !== "object") {
    throw new Error("browser task action must be an object");
  }
  const action = raw as Record<string, unknown>;
  const type = typeof action.type === "string" ? action.type : "";
  const selector = typeof action.selector === "string" ? action.selector.trim() : "";
  if (!["xai_email_login", "click", "fill", "press", "fill_mail_code", "wait_for_selector", "wait_for_url"].includes(type)) {
    throw new Error("browser task action type is not supported");
  }
  if (type === "xai_email_login") return { type };
  if (type === "wait_for_url") {
    const url = typeof action.url === "string" ? action.url.trim() : "";
    if (!url) {
      throw new Error("wait_for_url action requires url");
    }
    return { type: "wait_for_url", url };
  }
  if (!selector) {
    throw new Error(`${type} action requires selector`);
  }
  if (type === "fill") {
    if (typeof action.value !== "string") {
      throw new Error("fill action requires a string value");
    }
    return { type: "fill", selector, value: action.value };
  }
  if (type === "press") {
    if (typeof action.key !== "string" || !action.key.trim()) {
      throw new Error("press action requires key");
    }
    return { type: "press", selector, key: action.key };
  }
  if (type === "fill_mail_code") {
    return { type: "fill_mail_code", selector };
  }
  return type === "click" ? { type: "click", selector } : { type: "wait_for_selector", selector };
}

async function completeXaiEmailLogin(page: import("playwright").Page, context: import("playwright").BrowserContext, runtime: BrowserTaskRuntime): Promise<void> {
  const email = runtime.variables?.["account.email"] ?? "";
  const password = runtime.variables?.["account.password"] ?? "";
  if (!email) throw new Error("automatic xAI login requires an account email");
  const emailInput = page.locator('input[type="email"], input[autocomplete="email"], input[name="email"], #email').first();
  await emailInput.waitFor({ state: "visible", timeout: 30_000 });
  await emailInput.fill(email);
  await submitVisibleForm(page);
  for (let round = 0; round < 4; round += 1) {
    await page.waitForTimeout(1_500);
    if (await hasSsoCookie(context)) return;
    const passwordInput = page.locator('input[type="password"], input[autocomplete="current-password"]').first();
    if (password && await passwordInput.isVisible().catch(() => false)) {
      await passwordInput.fill(password);
      await submitVisibleForm(page);
      continue;
    }
    const codeInput = page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="code" i]').first();
    if (await codeInput.isVisible().catch(() => false)) {
      if (!runtime.waitForMailCode) throw new Error("xAI requested an email code but no mailbox reader is available");
      await codeInput.fill(await runtime.waitForMailCode());
      await submitVisibleForm(page);
      continue;
    }
  }
  await page.waitForTimeout(2_000);
  if (!await hasSsoCookie(context)) throw new Error("automatic xAI email login completed without an SSO cookie");
}

async function submitVisibleForm(page: import("playwright").Page): Promise<void> {
  const submit = page.locator('button[type="submit"], form button').first();
  if (await submit.isVisible().catch(() => false)) await submit.click({ timeout: 30_000 });
  else await page.keyboard.press("Enter");
}

async function hasSsoCookie(context: import("playwright").BrowserContext): Promise<boolean> {
  return (await context.cookies()).some((cookie) => cookie.name.toLowerCase() === "sso" || cookie.name.toLowerCase() === "sso-rw");
}

function resolveTemplate(value: string, variables: Readonly<Record<string, string>> | undefined): string {
  return value.replace(/\{\{([a-z][a-z0-9_.-]*)\}\}/gi, (_match, key: string) => variables?.[key] ?? "");
}
