#!/usr/bin/env node
// scripts/check-agent-notify.mjs
//
// End-to-end check for `pru notify`'s dashboard half: an `agent_notify`
// envelope arriving over the WebSocket becomes a browser Notification with
// the requested title and body, stays up until dismissed, opens its URL on
// click (or selects the agent when there is none), and fires nothing while
// the dashboard's notify toggle is off. The browser's Notification and
// window.open are replaced with recorders, since headless Chromium can't
// show real ones.
//
// Serves src/web/ over a stub backend (one project, two agents):
//
//   node scripts/check-agent-notify.mjs
//
// Env:
//   CHROMIUM_PATH  explicit browser binary (defaults to playwright's own)

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

/** A pretty-printed config blob, the shape an extension reporting its own
 *  state tends to emit. Truncating this to one line would make the toast
 *  useless, which is why long payloads get an expander. */
const CONFIG_PAYLOAD =
  "current config:\n" +
  JSON.stringify(
    {
      enabled: true,
      classifier: "example/classifier-model",
      thresholds: { escalate: 0.8, deescalate: 0.3 },
      overrides: ["bash", "edit", "write"],
    },
    null,
    2,
  );

async function startStubServer() {
  /** @type {Set<import("ws").WebSocket>} */
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path.startsWith("/api/")) {
      let body = {};
      if (path === "/api/agents") body = AGENTS;
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
    /** Push an envelope exactly as the server's UI context would. */
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

async function withDashboard(body, { viewport = { width: 1280, height: 800 } } = {}) {
  const stub = await startStubServer();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  try {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (err) => failures.push(`page error: ${err.message}`));
    await page.goto(`http://127.0.0.1:${stub.port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-agent-id]");
    // Select the first chat, so notifications for it are "for the chat
    // you're looking at".
    await page.click('[data-agent-id="agent-1"]');
    await page.waitForTimeout(200);
    await body(page, stub);
  } finally {
    await browser.close();
    await stub.close();
  }
}


/** Stand-ins for the browser APIs a notification touches. Recorded on
 *  window so the test can read what fired and click it. */
const RECORDERS = `
  window.__notifications = [];
  window.__opened = [];
  class RecordingNotification {
    static permission = "granted";
    static requestPermission() { return Promise.resolve("granted"); }
    constructor(title, options = {}) {
      this.title = title;
      this.options = options;
      this.closed = false;
      window.__notifications.push(this);
    }
    close() { this.closed = true; }
  }
  window.Notification = RecordingNotification;
  window.open = (url, target, features) => { window.__opened.push({ url, target, features }); return null; };
`;

const fired = (page) =>
  page.evaluate(() =>
    window.__notifications.map((n) => ({
      title: n.title,
      body: n.options.body,
      requireInteraction: n.options.requireInteraction ?? false,
    })),
  );

const agentNotify = (agentId, title, body, url) => ({
  kind: "agent_notify",
  agentId,
  title,
  body,
  ...(url ? { url } : {}),
});

async function withNotifications(enabled, body) {
  await withDashboard(async (page, stub) => {
    await page.evaluate((on) => localStorage.setItem("pirouette-notifications", on ? "1" : "0"), enabled);
    await body(page, stub);
  });
}

// Install the recorders before app.js runs in every page.
const realNewPage = chromium.launch;
chromium.launch = async (...args) => {
  const browser = await realNewPage.apply(chromium, args);
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...pageArgs) => {
    const page = await newPage(...pageArgs);
    await page.addInitScript(RECORDERS);
    return page;
  };
  return browser;
};

const settle = (page) => page.waitForTimeout(250);

console.log("a notification with a URL:");
await withNotifications(true, async (page, stub) => {
  stub.broadcast(agentNotify("agent-2", "AWS login needed", "approve code ABCD-EFGH", "https://example.com/device?user_code=ABCD-EFGH"));
  await settle(page);
  expect("fires one notification with the requested text", await fired(page), [
    { title: "AWS login needed", body: "approve code ABCD-EFGH", requireInteraction: true },
  ]);
  await page.evaluate(() => window.__notifications[0].onclick());
  expect(
    "clicking opens the URL in a new tab",
    await page.evaluate(() => window.__opened.map((o) => o.url)),
    ["https://example.com/device?user_code=ABCD-EFGH"],
  );
  expect("and closes the notification", await page.evaluate(() => window.__notifications[0].closed), true);
});

console.log("a notification without a URL:");
await withNotifications(true, async (page, stub) => {
  stub.broadcast(agentNotify("agent-2", "second-chat", "the deploy is waiting on you"));
  await settle(page);
  expect("fires even while the dashboard is focused", (await fired(page)).length, 1);
  await page.evaluate(() => window.__notifications[0].onclick());
  await settle(page);
  expect("clicking opens nothing", await page.evaluate(() => window.__opened.length), 0);
  expect(
    "and selects the agent it's about",
    await page.$eval("#agent-title", (el) => el.textContent.trim()),
    "second-chat",
  );
});

console.log("with the notify toggle off:");
await withNotifications(false, async (page, stub) => {
  stub.broadcast(agentNotify("agent-1", "first-chat", "should stay quiet"));
  await settle(page);
  expect("fires nothing", (await fired(page)).length, 0);
});

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nall agent-notify checks passed");
