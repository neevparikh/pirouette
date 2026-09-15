#!/usr/bin/env node
// Real server + browser regression. No production state, external requests,
// or agent processes. Run `npm run build && node scripts/check-browser-security.mjs`.
// BROWSERS=chromium,firefox,webkit (default: chromium).
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import * as playwright from "playwright";
import { runServer } from "../dist/server/index.js";

const dataDir = await mkdtemp(join(tmpdir(), "pir-browser-security-"));
const worktreePath = join(dataDir, "worktree");
const agent = {
  id: "security-demo", name: "security-demo", projectName: "scratchpad",
  worktreePath, branchName: null, sessionDir: join(dataDir, "sessions"),
  state: "stopped", createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
  model: null, thinkingLevel: "off", usage: { costUsd: 0, totalTokens: 0, turns: 0 },
  errorMessage: null, parentAgentId: null,
};
const project = { name: "scratchpad", repoPath: dataDir, repoUrl: null, worktreesDir: dataDir, defaultBranch: "main", createdAt: agent.createdAt };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const source = String.raw`A safe equation: \(\sqrt{x}+\frac{1}{2}\).

<div style="position:fixed;inset:0;background:url(https://example.com/style-probe)"><img src="https://example.com/html-probe"><script>document.documentElement.dataset.executed='yes'</script></div>

![remote](https://example.com/markdown-probe.png)
![relative-network](//example.com/network-probe.png)
[javascript](javascript:alert%281%29)

Local charts: ` + "`pixel.png`, `chart.svg`, `missing.png`.";
let handle;
try {
  await mkdir(join(dataDir, "state"));
  await mkdir(worktreePath);
  await writeFile(join(dataDir, "state", "pirouette-state.json"), JSON.stringify({ agents: { [agent.id]: agent }, projects: { scratchpad: project } }));
  await writeFile(join(worktreePath, "pixel.png"), Buffer.from(png, "base64"));
  await writeFile(join(worktreePath, "chart.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60" onload="document.documentElement.dataset.executed='yes'">
    <script>document.documentElement.dataset.executed='yes'</script>
    <image href="https://example.com/svg-probe.png" width="1" height="1"/>
    <rect width="80" height="60" style="fill:green"/>
  </svg>`);
  // runServer's host allowlist needs the actual port, not port 0.
  const listener = createServer();
  await new Promise((done) => listener.listen(0, "127.0.0.1", done));
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  handle = await runServer({ host: "127.0.0.1", port, dataDir, webDir: resolve(fileURLToPath(new URL("../dist/web/", import.meta.url))) });
  const origin = `http://127.0.0.1:${port}`;
  const svgUrl = `${origin}/api/agents/${agent.id}/file?path=chart.svg`;

  for (const name of (process.env.BROWSERS || "chromium").split(",")) {
    const browser = await playwright[name].launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.setDefaultTimeout(10_000);
      const requests = [], errors = [];
      const violations = [];
      page.on("pageerror", (err) => errors.push(err.message));
      await page.exposeFunction("recordViolation", (directive) => violations.push(directive));
      await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => window.recordViolation(e.effectiveDirective)));
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        // Existing, intentional font-provider loads are not message loads.
        if (!["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname)) requests.push(url.href);
        return route.abort();
      });
      await page.route(`**/api/agents/${agent.id}/messages`, (route) => route.fulfill({ json: { messages: [{ role: "assistant", content: source, ts: 0 }] } }));
      const response = await page.goto(origin);
      assert(response.headers()["content-security-policy"].includes("script-src 'self';"));
      await page.click(`[data-agent-id="${agent.id}"]`);
      await page.waitForSelector("#messages .katex");
      await page.waitForFunction(() => [...document.querySelectorAll(".pi-image-strip img")].some((i) => i.src.endsWith("pixel.png") && i.naturalWidth > 0));
      await page.waitForFunction(() => document.querySelector('.pi-image-strip a[title="missing.png"]')?.style.display === "none");
      assert.equal(await page.locator("#messages script, #messages [onerror], #messages [style*=fixed], #messages a[href^='javascript:']").count(), 0);
      assert.equal(await page.locator("#messages .math-fallback").count(), 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(violations, [], "normal rendering should not violate CSP");
      assert.deepEqual(requests, [], "messages must not initiate remote loads");
      // Real WS, not a Playwright mock: the app must connect under CSP.
      const wsWorks = await page.evaluate(() => new Promise((resolve) => {
        const ws = new WebSocket(`ws://${location.host}/ws`);
        ws.onopen = () => { ws.close(); resolve(true); };
        ws.onerror = () => resolve(false);
      }));
      assert(wsWorks, "same-origin WebSocket connects under CSP");

      // Bypass the renderer deliberately to exercise the browser policy.
      await page.evaluate((svgUrl) => {
        const inline = document.createElement("script");
        inline.textContent = "document.documentElement.dataset.executed='yes'";
        document.body.append(inline);
        const button = document.createElement("button");
        button.setAttribute("onclick", "document.documentElement.dataset.executed='yes'");
        document.body.append(button); button.click();
        const remote = document.createElement("img"); remote.src = "https://example.com/csp-image-probe";
        document.body.append(remote);
        const background = document.createElement("div");
        background.style.backgroundImage = 'url("https://example.com/csp-style-probe")';
        document.body.append(background);
        const script = document.createElement("script"); script.src = svgUrl;
        document.body.append(script);
      }, svgUrl);
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.executed), undefined);
      assert(violations.includes("script-src-elem"));
      assert(violations.includes("script-src-attr"));
      assert(violations.includes("img-src"));
      assert.deepEqual(requests, [], "CSP blocks resource loads even without renderer filtering");

      const svgResponse = await page.goto(svgUrl);
      assert(svgResponse.headers()["content-security-policy"].startsWith("sandbox;"));
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.executed), undefined, "SVG scripts/event handlers cannot execute");
      assert(await page.evaluate(() => { try { localStorage.getItem("test"); return false; } catch { return true; } }), "opened SVG has opaque origin");
      assert.equal(await page.locator("rect").count(), 1, "SVG chart still displays");
      assert.deepEqual(requests, [], "SVG cannot load remote resources");
      console.log(`${name}: message filtering, CSP, local images, math, real WS, and SVG sandbox passed`);
    } finally { await browser.close(); }
  }
} catch (error) {
  // The server installs process-level error logging. Do not let that turn
  // an assertion failure in this standalone check into a successful exit.
  console.error(error);
  process.exitCode = 1;
} finally {
  await handle?.shutdown();
  await rm(dataDir, { recursive: true, force: true });
}
