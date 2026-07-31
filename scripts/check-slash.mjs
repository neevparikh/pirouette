#!/usr/bin/env node
// scripts/check-slash.mjs
//
// End-to-end check for slash commands typed into the composer, run against
// a real browser. The interesting part isn't the parsing (that's a string
// split) but what happens to the composer afterwards: a dispatched command
// has to leave an empty box, including the commands that block the frame
// on a modal, and a command we don't own has to leave the text alone so it
// can still be sent to the agent.
//
// Serves src/web/ over a stub backend (one project, one agent) and drives
// Chromium:
//
//   node scripts/check-slash.mjs
//
// Env:
//   CHROMIUM_PATH  explicit browser binary (defaults to playwright's own)
//
// Exits non-zero on the first failed expectation, so it can be wired into
// a pre-publish smoke check.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";

const WEB_ROOT = fileURLToPath(new URL("../src/web/", import.meta.url));
const AGENT_ID = "agent-1";
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const PROJECT = {
  name: "scratchpad",
  repoUrl: null,
  repoPath: "/tmp/pirouette-check",
  worktreesDir: "/tmp/pirouette-check/worktrees",
  defaultBranch: null,
  createdAt: new Date().toISOString(),
};

const AGENT = {
  id: AGENT_ID,
  name: "demo",
  projectName: PROJECT.name,
  worktreePath: PROJECT.repoPath,
  branchName: null,
  sessionDir: `${PROJECT.repoPath}/session`,
  state: "waiting_input",
  createdAt: new Date().toISOString(),
  lastActivity: new Date().toISOString(),
  model: "demo-model",
  thinkingLevel: "off",
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
};

/** Static file + stub API server. Records the POST bodies the page sends
 *  so assertions can look at side effects rather than page internals. */
async function startStubServer() {
  const renames = [];
  const messages = [];
  const agent = { ...AGENT };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path.startsWith("/api/")) {
      if (req.method === "POST") {
        const body = await new Promise((resolve) => {
          let raw = "";
          req.on("data", (c) => (raw += c));
          req.on("end", () => {
            try {
              resolve(JSON.parse(raw || "{}"));
            } catch {
              resolve({});
            }
          });
        });
        if (path === `/api/agents/${AGENT_ID}/rename`) {
          renames.push(body);
          agent.name = body.name;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...agent }));
          return;
        }
        if (path === `/api/agents/${AGENT_ID}/message`) {
          messages.push(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      let body = {};
      if (path === "/api/agents") body = [agent];
      else if (path === "/api/projects") body = [PROJECT];
      else if (path.endsWith("/messages")) body = { messages: [] };
      else if (path === "/api/skills") body = { skills: [] };
      else if (path === "/api/commands") body = { commands: [] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    const file = path === "/" ? "index.html" : path.replace(/^\//, "");
    try {
      const buf = await readFile(join(WEB_ROOT, file));
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "text/plain" });
      res.end(buf);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ kind: "projects_list", projects: [PROJECT] }));
    ws.send(JSON.stringify({ kind: "agents_list", agents: [agent] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    renames,
    messages,
    async close() {
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const failures = [];
function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}: ${JSON.stringify(actual)}`);
  if (!ok) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Boot the dashboard with the one stub agent selected and the caret in
 *  the composer, then hand the page to `body`. */
async function withDashboard(body) {
  const stub = await startStubServer();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (err) => failures.push(`page error: ${err.message}`));
    await page.goto(`http://127.0.0.1:${stub.port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-agent-id]");
    await page.click("[data-agent-id]");
    await page.focus("#message-input");
    await body(page, stub);
  } finally {
    await browser.close();
    await stub.close();
  }
}

const composer = (page) => page.locator("#message-input").inputValue();
const title = (page) => page.locator("#agent-title").textContent();
/** Type into the composer and press Enter, then let the dispatch settle. */
const submit = async (page, text) => {
  await page.locator("#message-input").fill(text);
  // `fill` doesn't fire the keystrokes the popup listens to; nudge it.
  await page.locator("#message-input").dispatchEvent("input");
  await page.waitForTimeout(100);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
};

// The bug this file was written for: /rename does its job, but the command
// text stays in the composer, so the next chat you click into starts with
// someone else's `/rename ...` still in the box.
console.log("/rename typed out in full:");
await withDashboard(async (page, stub) => {
  await submit(page, "/rename renamed-by-slash");
  expect("renamed", stub.renames, [{ name: "renamed-by-slash" }]);
  expect("header follows", (await title(page)).trim(), "renamed-by-slash");
  expect("composer is empty", await composer(page), "");
  expect("and nothing was sent to the agent", stub.messages.length, 0);
});

// Same command, dispatched off the autocomplete popup (Enter with the
// popup open takes a different path through app.js).
console.log("/rename dispatched from the popup, then answered in the prompt:");
await withDashboard(async (page, stub) => {
  await page.evaluate(() => {
    window.prompt = () => "renamed-by-prompt";
  });
  await page.locator("#message-input").pressSequentially("/rename");
  await page.waitForTimeout(150);
  expect("popup is open", await page.locator("#slash-popup").isVisible(), true);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  expect("renamed", stub.renames, [{ name: "renamed-by-prompt" }]);
  expect("composer is empty", await composer(page), "");
});

// A command we don't own is not ours to consume: it goes to the agent as
// a message (pi may know it), and sendMessage does the clearing.
console.log("a command the dashboard doesn't own:");
await withDashboard(async (page, stub) => {
  await submit(page, "/definitely-not-a-pirouette-command");
  expect("forwarded to the agent", stub.messages.map((m) => m.message), [
    "/definitely-not-a-pirouette-command",
  ]);
  expect("composer is empty", await composer(page), "");
  expect("and no rename happened", stub.renames.length, 0);
});

// A client command that opens a modal instead of returning: the composer
// has to be empty while the picker is up, not after it closes.
console.log("/model, which hands the page to a picker:");
await withDashboard(async (page) => {
  await submit(page, "/model");
  expect("picker is open", await page.locator("#model-picker").isVisible(), true);
  expect("composer is empty behind it", await composer(page), "");
});

// Plain prose must survive all of the above untouched.
console.log("an ordinary message:");
await withDashboard(async (page, stub) => {
  await submit(page, "hello, not a command");
  expect("sent", stub.messages.map((m) => m.message), ["hello, not a command"]);
  expect("composer is empty", await composer(page), "");
});

if (failures.length > 0) {
  console.log("\n--- failures ---");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log("\nall slash-command checks passed");
process.exit(0);
