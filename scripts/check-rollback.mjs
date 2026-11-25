#!/usr/bin/env node
// scripts/check-rollback.mjs
//
// End-to-end check for rolling a chat back out of a refused turn, run
// against a real browser: the button on the refusal's error row, what the
// confirm dialog names, what is sent to the server, and the rolled-back
// message landing in the composer. `/rollback` takes the same path with no
// row to start from.
//
// Serves src/web/ over a stub backend (one project, one agent whose last
// turn was refused) and drives Chromium:
//
//   node scripts/check-rollback.mjs
//
// Env:
//   CHROMIUM_PATH  explicit browser binary (defaults to playwright's own)
//
// Exits non-zero on the first failed expectation.

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

/** What GET /messages returns before the rollback: an answered turn, then
 *  a turn refused after a tool call, then a second message refused too. */
const HISTORY = [
  { role: "user", content: "first question", ts: 10 },
  { role: "assistant", content: "first answer", ts: 11 },
  { role: "user", content: "look into the exploit", ts: 20 },
  { role: "tool", content: "▶ bash", toolName: "bash", toolCallId: "t1", args: { command: "ls" }, ts: 21 },
  { role: "tool_result", content: "ok", toolName: "bash", toolCallId: "t1", ts: 22 },
  { role: "system", content: "Error: blocked under the Usage Policy", ts: 23, blocked: true },
  { role: "user", content: "please carry on", ts: 30 },
  { role: "system", content: "Error: blocked under the Usage Policy", ts: 31, blocked: true },
  { role: "user", content: "try once more", ts: 40 },
  { role: "system", content: "Error: 529 overloaded", ts: 41 },
];

/** Static file + stub API server. A rollback truncates the history at the
 *  message it names and broadcasts `agent_rolled_back`, as the real server
 *  does. Records the POST bodies so assertions look at side effects. */
async function startStubServer() {
  const rollbacks = [];
  let history = [...HISTORY];
  const sockets = new Set();
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
        if (path === `/api/agents/${AGENT_ID}/rollback`) {
          rollbacks.push(body);
          const at = history.findIndex((m) => m.ts === body.beforeTs);
          const text = history[at].content;
          history = history.slice(0, at);
          for (const ws of sockets) ws.send(JSON.stringify({ kind: "agent_rolled_back", agentId: AGENT_ID }));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, text, kind: "user", dropped: 1 }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      let body = {};
      if (path === "/api/agents") body = [AGENT];
      else if (path === "/api/projects") body = [PROJECT];
      else if (path.endsWith("/messages")) body = { messages: history };
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
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    ws.send(JSON.stringify({ kind: "projects_list", projects: [PROJECT] }));
    ws.send(JSON.stringify({ kind: "agents_list", agents: [AGENT] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    rollbacks,
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
const buttons = (page) => page.locator("[data-rollback-ts]");
/** Answer the next confirm dialog and keep what it said. */
const answerConfirm = (page, accept) => {
  const seen = { message: null };
  page.once("dialog", async (dialog) => {
    seen.message = dialog.message();
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
  return seen;
};

console.log("the button on a refused turn:");
await withDashboard(async (page, stub) => {
  await page.waitForSelector("[data-rollback-ts]");
  expect("one per refusal, none on an ordinary error", await buttons(page).count(), 2);

  const declined = answerConfirm(page, false);
  await buttons(page).first().click();
  await page.waitForTimeout(200);
  expect("confirm names the message that started the turn", declined.message.includes('"look into the exploit"'), true);
  expect("declining sends nothing", stub.rollbacks, []);

  await page.locator("#message-input").fill("a draft");
  answerConfirm(page, true);
  await buttons(page).first().click();
  await page.waitForFunction(() => document.querySelectorAll("[data-rollback-ts]").length === 0);
  expect("rolled back to that message", stub.rollbacks, [{ beforeTs: 20 }]);
  expect("the turn is gone from the transcript", await page.locator("#messages").innerText().then((t) => t.includes("exploit")), false);
  expect("the first turn is still there", await page.locator("#messages").innerText().then((t) => t.includes("first answer")), true);
  expect("message is back in the composer, above the draft", await composer(page), "look into the exploit\n\na draft");
});

console.log("/rollback, with no row to start from:");
await withDashboard(async (page, stub) => {
  await page.waitForSelector("[data-rollback-ts]");
  const seen = answerConfirm(page, true);
  await page.locator("#message-input").fill("/rollback");
  await page.locator("#message-input").dispatchEvent("input");
  await page.waitForTimeout(100);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#message-input").value !== "");
  expect("confirm names the last message", seen.message.includes('"try once more"'), true);
  expect("rolled back to it", stub.rollbacks, [{ beforeTs: 40 }]);
  expect("composer holds it, not the command", await composer(page), "try once more");
});

if (failures.length > 0) {
  console.log("\n--- failures ---");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log("\nall rollback checks passed");
process.exit(0);
