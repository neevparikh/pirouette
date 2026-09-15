#!/usr/bin/env node
// Browser regression: history, streaming, raw mode, local fonts and mobile
// overflow under production CSP. Run `npm run build && node scripts/check-math.mjs`.
// Optional: CHROMIUM_PATH, MATH_SCREENSHOT (output PNG path).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { dashboardCsp } from "../dist/server/content-security.js";

const root = fileURLToPath(new URL("../src/web/", import.meta.url));
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
const server = createServer(async (req, res) => {
  res.setHeader("content-security-policy", dashboardCsp(req.headers.host));
  res.setHeader("x-content-type-options", "nosniff");
  const path = new URL(req.url, "http://localhost").pathname;
  const file = resolve(root, "." + (path === "/" ? "/index.html" : path));
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) return res.writeHead(404).end();
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" }).end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const project = { name: "scratchpad", repoPath: "/tmp/math-demo" };
const agent = { id: "math-demo", name: "math-demo", projectName: project.name, state: "waiting_input", model: "demo", usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 } };
const source = String.raw`The mean is \(\bar{x}=\frac{1}{n}\sum_{i=1}^{n}x_i\).

\[
\begin{aligned}
y &= x^2+1 \\
z &= \sqrt{y}+\frac{1}{2}
\end{aligned}
\]

| Quantity | Formula |
| --- | --- |
| Mean | $\bar{x}$ |
| Variance | $\sigma^2$ |

Code stays literal: ` + '`\\(x\\)`.';
const history = [{ role: "assistant", content: source, ts: Date.now() }];
const errors = [];
const fontResponses = [];
const violations = [];
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (err) => errors.push(err.message));
  await page.exposeFunction("recordViolation", (directive) => violations.push(directive));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (event) => window.recordViolation(event.effectiveDirective)));
  page.on("response", (r) => { if (r.url().includes("/vendor/katex/fonts/")) fontResponses.push(r); });
  // The entire check runs offline except for this local static server.
  await page.route("**/*", (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    if (path === "/api/agents") body = [agent];
    else if (path === "/api/projects") body = [project];
    else if (path.endsWith("/messages")) body = { messages: history };
    else if (path === "/api/skills") body = { skills: [] };
    else if (path === "/api/commands") body = { commands: [] };
    await route.fulfill({ json: body });
  });
  let socket;
  await page.routeWebSocket("**/ws", (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ kind: "projects_list", projects: [project] }));
    ws.send(JSON.stringify({ kind: "agents_list", agents: [agent] }));
  });
  const send = (event) => socket.send(JSON.stringify({ kind: "agent_event", agentId: agent.id, event }));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.click('[data-agent-id="math-demo"]');
  await page.waitForSelector("#messages .katex-display");
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator("#messages .katex").count(), 4);
  assert.equal(await page.locator("#messages table td .katex").count(), 2);
  assert.equal(await page.locator("#messages code").textContent(), String.raw`\(x\)`);
  assert(fontResponses.length > 0 && fontResponses.every((r) => r.ok()), "KaTeX fonts load locally");
  assert(await page.evaluate(() => document.fonts.check('16px "KaTeX_Main"')), "math font is usable");

  send({ type: "message_start", role: "assistant" });
  send({ type: "message_update", updateType: "text_delta", delta: "Streaming equation: " });
  await page.waitForSelector("#streaming-body .pi-md");
  send({ type: "message_update", updateType: "text_delta", delta: String.raw`\[\frac{a+b}{c}` });
  await page.waitForSelector("#streaming-body .math-fallback");
  send({ type: "message_update", updateType: "text_delta", delta: String.raw`\]` });
  await page.waitForSelector("#streaming-body .katex-display");
  assert.equal(await page.locator("#streaming-body .streaming-cursor").count(), 1);

  await page.click("#agent-raw-btn");
  await page.waitForFunction(() => !document.querySelector("#messages .katex"));
  send({ type: "message_update", updateType: "text_delta", delta: " Still raw." });
  await page.waitForFunction(() => document.querySelector("#streaming-body")?.textContent.includes("Still raw."));
  assert.equal(await page.locator("#streaming-body .katex").count(), 0);
  assert((await page.locator("#streaming-body").textContent()).includes(String.raw`\[\frac{a+b}{c}\]`));
  await page.click("#agent-raw-btn");
  await page.waitForSelector("#streaming-body .katex-display");

  // Wide display math must scroll inside the message, not widen the page.
  send({ type: "message_update", updateType: "text_delta", delta: "\n\n$$" + "x+".repeat(60) + "1$$" });
  await page.waitForFunction(() => document.querySelectorAll("#streaming-body .katex-display").length === 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile page does not overflow");
  assert(await page.locator("#streaming-body .katex-display").last().evaluate((el) => el.scrollWidth > el.clientWidth), "wide equation scrolls locally");
  assert.equal(await page.locator("#messages pre .math-document").count(), 0);
  // Equations inherit theme colors instead of hard-coding black text.
  await page.evaluate(() => document.documentElement.style.setProperty("--color-base16-600", "30 40 50"));
  assert.equal(await page.locator("#messages .katex").first().evaluate((el) => getComputedStyle(el).color), "rgb(30, 40, 50)");
  if (process.env.MATH_SCREENSHOT) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: process.env.MATH_SCREENSHOT });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(violations, [], "normal math/UI needs no CSP exceptions");
  console.log("Math history, streaming, raw mode, local fonts, theme colors and mobile overflow passed.");
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
