#!/usr/bin/env node
// scripts/check-user-messages.mjs
//
// End-to-end check that a user message shows up in the transcript no matter
// who sent it. The dashboard used to render user messages from exactly one
// source — an optimistic append in the tab that typed them — so a message
// from `pru send`, from an agent briefing the agent it just launched, or
// from a second tab was invisible until the next history refetch. They now
// come off pi's `message_end` event, which means the tab that *did* type
// the message sees it twice unless the echo is reconciled with the
// optimistic copy. Both halves are what this checks, in a real browser:
// unit tests can exercise the reducer but not "the envelope reached
// app.js's handler and painted a row".
//
// Serves src/web/ over a stub backend (one project, two chats) and drives
// Chromium:
//
//   node scripts/check-user-messages.mjs
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

const agent = (id, name) => ({
  id,
  name,
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
});

const AGENTS = [agent("agent-1", "first-chat"), agent("agent-2", "second-chat")];

// 1x1 transparent PNG, as the server hands attachments to the client.
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function startStubServer() {
  /** @type {Set<import("ws").WebSocket>} */
  const sockets = new Set();
  /** Messages the dashboard POSTed, so a check can assert the send landed. */
  const sent = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path.startsWith("/api/")) {
      let body = {};
      if (req.method === "POST" && path.endsWith("/message")) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        sent.push(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } else if (path === "/api/agents") body = AGENTS;
      else if (path === "/api/projects") body = [PROJECT];
      else if (path.endsWith("/messages")) body = { messages: [] };
      else if (path.endsWith("/stats")) body = {};
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
    ws.send(JSON.stringify({ kind: "agents_list", agents: AGENTS }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    sent,
    /** Push an envelope exactly as the server's event bridge would. */
    broadcast(envelope) {
      for (const ws of sockets) ws.send(JSON.stringify(envelope));
    },
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
  if (!ok) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

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
    await page.click('[data-agent-id="agent-1"]');
    await page.waitForTimeout(200);
    await body(page, stub);
  } finally {
    await browser.close();
    await stub.close();
  }
}

/** A normalized pi event, wrapped the way the server broadcasts it. */
const event = (agentId, ev) => ({ kind: "agent_event", agentId, event: ev });
const userMessage = (agentId, text, images) =>
  event(agentId, { type: "message_end", role: "user", text, ...(images ? { images } : {}) });

const userRows = (page) =>
  page.$$eval(".pi-row-user", (els) => els.map((el) => el.textContent.trim()));

/** Wait for the envelope to cross the socket and paint. */
const settle = (page) => page.waitForTimeout(250);

console.log("a message sent from outside the browser:");
await withDashboard(async (page, stub) => {
  // What `pru send` / an agent briefing another agent looks like on the wire.
  stub.broadcast(userMessage("agent-1", "start on the refactor"));
  await settle(page);
  expect("appears in the transcript", await userRows(page), ["start on the refactor"]);

  stub.broadcast(userMessage("agent-1", "and open a draft PR"));
  await settle(page);
  expect("and so does the next one", await userRows(page), [
    "start on the refactor",
    "and open a draft PR",
  ]);
});

console.log("a message typed into the composer:");
await withDashboard(async (page, stub) => {
  await page.fill("#message-input", "look at the failing test");
  await page.click("#send-btn");
  await settle(page);
  expect("shows immediately, before the server says anything", await userRows(page), [
    "look at the failing test",
  ]);
  expect("and was actually sent", stub.sent.map((s) => s.message), [
    "look at the failing test",
  ]);

  // The echo of our own message must land on the row we already drew.
  stub.broadcast(userMessage("agent-1", "look at the failing test"));
  await settle(page);
  expect("the server's echo doesn't duplicate it", await userRows(page), [
    "look at the failing test",
  ]);
});

console.log("the same text sent twice:");
await withDashboard(async (page, stub) => {
  for (let i = 0; i < 2; i++) {
    await page.fill("#message-input", "continue");
    await page.click("#send-btn");
    await settle(page);
  }
  expect("both rows are drawn", await userRows(page), ["continue", "continue"]);
  stub.broadcast(userMessage("agent-1", "continue"));
  stub.broadcast(userMessage("agent-1", "continue"));
  await settle(page);
  expect("and both echoes are absorbed", await userRows(page), ["continue", "continue"]);
});

console.log("a message that lands mid-turn:");
await withDashboard(async (page, stub) => {
  stub.broadcast(event("agent-1", { type: "message_start", role: "assistant" }));
  stub.broadcast(
    event("agent-1", { type: "message_update", updateType: "text_delta", delta: "working on it" }),
  );
  await settle(page);
  // A steering message from another client, consumed by the running turn.
  stub.broadcast(userMessage("agent-1", "actually, stop"));
  await settle(page);
  expect("shows up without waiting for the turn to end", await userRows(page), [
    "actually, stop",
  ]);
  expect(
    "and the in-flight response is still on screen",
    (await page.textContent("#streaming-body")).includes("working on it"),
    true,
  );
});

console.log("image attachments:");
await withDashboard(async (page, stub) => {
  stub.broadcast(
    userMessage("agent-1", "what is this?", [{ dataUrl: PIXEL, mimeType: "image/png" }]),
  );
  await settle(page);
  expect(
    "render inline",
    await page.$$eval(".pi-row-user img", (els) => els.map((el) => el.getAttribute("src"))),
    [PIXEL],
  );
});

console.log("another chat's message:");
await withDashboard(async (page, stub) => {
  stub.broadcast(userMessage("agent-2", "for the other chat"));
  await settle(page);
  expect("stays out of the chat you're reading", await userRows(page), []);
});

if (failures.length > 0) {
  console.log("\n--- failures ---");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log("\nall user-message checks passed");
process.exit(0);
