#!/usr/bin/env node
// scripts/check-escape.mjs
//
// End-to-end check for the dashboard's Escape key, run against a real
// browser. Unit tests can cover the precedence rules (src/web/keys.js), but
// not the thing that actually broke here: WHO gets the keydown first when a
// document-level capture listener and the composer's own vim layer both
// want Escape. That only shows up in a browser.
//
// Serves src/web/ over a stub backend (one project, one agent whose state
// is whatever we say) and drives Chromium:
//
//   node scripts/check-escape.mjs
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

function makeAgent(state) {
  return {
    id: AGENT_ID,
    name: "demo",
    projectName: PROJECT.name,
    worktreePath: PROJECT.repoPath,
    branchName: null,
    sessionDir: `${PROJECT.repoPath}/session`,
    state,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    model: "demo-model",
    thinkingLevel: "off",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

/** Static file + stub API server. `interrupts` counts POSTs to the
 *  interrupt endpoint so the assertions can look for the side effect
 *  rather than at internal page state. */
async function startStubServer(agentState) {
  const interrupts = [];
  const agent = makeAgent(agentState);
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path.startsWith("/api/")) {
      if (req.method === "POST" && path === `/api/agents/${AGENT_ID}/interrupt`) {
        interrupts.push(Date.now());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ interrupted: true, cleared: { steering: [], followUp: [] } }));
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
    interrupts,
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

/** Boot the dashboard with the agent in `agentState`, put the caret in the
 *  composer, and hand the page to `body`. */
async function withDashboard({ agentState, vim }, body) {
  const stub = await startStubServer(agentState);
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (err) => failures.push(`page error: ${err.message}`));
    const url = `http://127.0.0.1:${stub.port}/`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (vim) {
      await page.evaluate(() => localStorage.setItem("pirouette-vim-mode", "1"));
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    await page.waitForSelector("[data-agent-id]");
    await page.click("[data-agent-id]");
    await page.focus("#message-input");
    await page.keyboard.type("a queued thought");
    await body(page, stub);
  } finally {
    await browser.close();
    await stub.close();
  }
}

const vimLabel = (page) => page.locator("#vim-mode-label").textContent();
const focused = (page) => page.evaluate(() => document.activeElement?.id ?? null);
const press = async (page, key) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(250);
};

console.log("escape, vim off, agent running:");
await withDashboard({ agentState: "running", vim: false }, async (page, stub) => {
  expect("interrupt pill visible", await page.locator("#agent-interrupt-btn").isVisible(), true);
  await press(page, "Escape");
  expect("interrupts", stub.interrupts.length, 1);
  expect("focus stays in the composer", await focused(page), "message-input");
});

console.log("escape, vim on, agent running:");
await withDashboard({ agentState: "running", vim: true }, async (page, stub) => {
  expect("starts in insert mode", await vimLabel(page), "INSERT");
  await press(page, "Escape");
  // The bug: the first Escape used to be eaten by vim's insert -> normal
  // transition, leaving the turn running and the composer unusable.
  expect("interrupts on the first press", stub.interrupts.length, 1);
  expect("stays in insert mode", await vimLabel(page), "INSERT");
  expect("focus stays in the composer", await focused(page), "message-input");
  // Ctrl+[ is the escape hatch for reaching normal mode mid-turn.
  await press(page, "Control+[");
  expect("ctrl-[ reaches normal mode", await vimLabel(page), "NORMAL");
  expect("ctrl-[ does not interrupt", stub.interrupts.length, 1);
});

console.log("escape, vim on, agent idle:");
await withDashboard({ agentState: "waiting_input", vim: true }, async (page, stub) => {
  await press(page, "Escape");
  expect("no interrupt when nothing is in flight", stub.interrupts.length, 0);
  expect("vim gets the key", await vimLabel(page), "NORMAL");
});

if (failures.length > 0) {
  console.log("\n--- failures ---");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log("\nall escape checks passed");
process.exit(0);
