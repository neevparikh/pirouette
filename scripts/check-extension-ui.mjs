#!/usr/bin/env node
// scripts/check-extension-ui.mjs
//
// End-to-end check for the extension UI surfaces — the toast deck fed by
// `extension_ui_notify`, the header status strip fed by
// `extension_ui_status`, and the widget strips fed by
// `extension_ui_widget`. All three arrive over the WebSocket, so the parts
// worth checking are the ones a unit test can't reach: that a real envelope
// reaches app.js's handler and paints something, that a wall of JSON is
// readable rather than truncated, that a burst never covers the composer,
// that one chat's notifications don't surface while you're reading another,
// and that a pinned widget stays put without pushing the composer around.
//
// Serves src/web/ over a stub backend (one project, two agents) and drives
// Chromium:
//
//   node scripts/check-extension-ui.mjs
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

const notify = (agentId, message, notifyType) => ({
  kind: "extension_ui_notify",
  agentId,
  message,
  notifyType,
});
const status = (agentId, statusKey, statusText) => ({
  kind: "extension_ui_status",
  agentId,
  statusKey,
  statusText,
});

const toastTexts = (page) =>
  page.$$eval("[data-toast-id]", (els) => els.map((el) => el.textContent.trim()));
const toastCount = (page) => page.$$eval("[data-toast-id]", (els) => els.length);
const statusTexts = (page) =>
  page.$$eval("[data-status-key]", (els) => els.map((el) => el.textContent.trim()));
const widgetKeys = (page, host = "extension-widgets") =>
  page.$$eval(`#${host} [data-widget-key]`, (els) => els.map((el) => el.dataset.widgetKey));
const widgetText = (page, host = "extension-widgets") =>
  page.$$eval(`#${host} [data-widget-key]`, (els) => els.map((el) => el.textContent));

/** A todo-list widget in the shape server/widget-render.ts emits: lines of
 *  spans carrying pi's semantic colour names. */
const todoWidget = (done, total, placement = "aboveEditor") => ({
  key: "todo-list",
  placement,
  lines: [
    [
      { text: " Todo List ", color: "accent", bold: true },
      { text: `— ${done}/${total} completed`, color: "muted" },
    ],
    [
      { text: "  ✓ " },
      { text: "1.", color: "accent" },
      { text: " wire up setWidget", color: "dim", strikethrough: true },
    ],
    [
      { text: "  ◉ " },
      { text: "2.", color: "accent" },
      { text: " render it in the dashboard", color: "warning" },
    ],
  ],
});
const widgetEnvelope = (agentId, widget, widgetKey = "todo-list") => ({
  kind: "extension_ui_widget",
  agentId,
  widgetKey,
  widget,
});

/** Wait for the notification to make it across the socket and paint. */
const settle = (page) => page.waitForTimeout(250);

console.log("a notification for the chat you're reading:");
await withDashboard(async (page, stub) => {
  stub.broadcast(notify("agent-1", "switched to automatic mode", "info"));
  await settle(page);
  expect("shows one toast", await toastCount(page), 1);
  expect(
    "with the extension's message",
    (await toastTexts(page))[0].includes("switched to automatic mode"),
    true,
  );
  expect(
    "styled by type",
    await page.getAttribute("[data-toast-id]", "data-toast-type"),
    "info",
  );
  stub.broadcast(notify("agent-1", "classifier unavailable", "error"));
  await settle(page);
  expect(
    "and an error toast is marked as one",
    await page.$$eval("[data-toast-id]", (els) => els.map((el) => el.dataset.toastType)),
    ["info", "error"],
  );
});

console.log("dismissal:");
await withDashboard(async (page, stub) => {
  stub.broadcast(notify("agent-1", "click me away", "info"));
  await settle(page);
  await page.click("[data-toast-close]");
  expect("the ✕ dismisses it", await toastCount(page), 0);

  stub.broadcast(notify("agent-1", "brief", "info"));
  await settle(page);
  expect("a new one is up", await toastCount(page), 1);
  // Hovering holds a toast open — you can't lose a message by reading it.
  await page.hover("[data-toast-id]");
  await page.waitForTimeout(8_000);
  expect("hovering holds it open", await toastCount(page), 1);
  // Move off it and the countdown restarts. Info toasts live ~6s plus a
  // small per-character bonus; nothing else in this harness is slow, so
  // waiting it out beats mocking the clock.
  await page.mouse.move(20, 400);
  await page.waitForTimeout(8_000);
  expect("and auto-dismisses once you look away", await toastCount(page), 0);
});

console.log("a wall of JSON stays readable:");
await withDashboard(async (page, stub) => {
  stub.broadcast(notify("agent-1", CONFIG_PAYLOAD, "info"));
  await settle(page);
  expect(
    "collapsed to its first line",
    (await toastTexts(page))[0].startsWith("infocurrent config:"),
    true,
  );
  expect(
    "with a count of what's hidden",
    (await page.textContent("[data-toast-expand]")).includes("+13 lines"),
    true,
  );
  await page.click("[data-toast-expand]");
  await settle(page);
  const pre = await page.textContent("#extension-toasts pre");
  expect("expands to the whole payload", pre === CONFIG_PAYLOAD, true);
  expect(
    "in a scrollable box",
    await page.$eval("#extension-toasts pre", (el) => {
      const s = getComputedStyle(el);
      return s.overflowY !== "visible" && parseInt(s.maxHeight, 10) > 0;
    }),
    true,
  );
  // Expanded toasts are pinned: an auto-dismiss mid-read would be worse
  // than useless.
  await page.waitForTimeout(9_000);
  expect("and stays up while expanded", await toastCount(page), 1);
});

console.log("a burst can't take over the screen:");
await withDashboard(async (page, stub) => {
  for (let i = 1; i <= 6; i++) stub.broadcast(notify("agent-1", `message ${i}`, "info"));
  await settle(page);
  expect("at most three on screen", await toastCount(page), 3);
  const overlap = await page.evaluate(() => {
    const deck = document.getElementById("extension-toasts").getBoundingClientRect();
    const bar = document.getElementById("input-bar").getBoundingClientRect();
    return deck.bottom > bar.top;
  });
  expect("nothing covers the composer", overlap, false);
  expect(
    "clicking through a toast lands on the transcript, not the deck",
    await page.evaluate(() => {
      const deck = document.getElementById("extension-toasts").getBoundingClientRect();
      const el = document.elementFromPoint(deck.left - 40, deck.top + 20);
      return el?.closest("#extension-toasts") === null;
    }),
    true,
  );
  // Dismissing one lets a queued message through rather than losing it.
  await page.click("[data-toast-close]");
  await settle(page);
  expect("dismissing frees a slot", await toastCount(page), 3);
});

console.log("notifications are per chat:");
await withDashboard(async (page, stub) => {
  stub.broadcast(notify("agent-2", "not for the chat on screen", "warn"));
  await settle(page);
  expect("nothing pops up for the other chat", await toastCount(page), 0);
  expect(
    "but the chat list says something is waiting",
    await page.$eval('[data-agent-row="agent-2"] button', (el) =>
      el.textContent.includes("•")),
    true,
  );
  await page.click('[data-agent-id="agent-2"]');
  await settle(page);
  expect("switching over releases it", await toastCount(page), 1);
  expect(
    "with the queued message",
    (await toastTexts(page))[0].includes("not for the chat on screen"),
    true,
  );
  await page.click('[data-agent-id="agent-1"]');
  await settle(page);
  expect("and it doesn't follow you back", await toastCount(page), 0);
});

console.log("the status strip:");
await withDashboard(async (page, stub) => {
  stub.broadcast(status("agent-1", "sample-extension", "auto ✓ (classifier: some-model)"));
  await settle(page);
  expect("shows the extension's status", await statusTexts(page), [
    "auto ✓ (classifier: some-model)",
  ]);
  stub.broadcast(status("agent-1", "sample-extension", "auto ⚠ (classifier unavailable)"));
  await settle(page);
  expect("updates in place for the same key", await statusTexts(page), [
    "auto ⚠ (classifier unavailable)",
  ]);
  stub.broadcast(status("agent-1", "another-extension", "2 tasks"));
  await settle(page);
  expect("keeps several keys side by side", (await statusTexts(page)).length, 2);
  expect(
    "without pushing the chat name off screen",
    await page.evaluate(() => {
      const title = document.getElementById("agent-title").getBoundingClientRect();
      return title.width > 0 && title.right <= window.innerWidth;
    }),
    true,
  );
  stub.broadcast(status("agent-1", "sample-extension", null));
  stub.broadcast(status("agent-1", "another-extension", null));
  await settle(page);
  expect("null clears a key", await statusTexts(page), []);
  expect(
    "and the empty strip disappears",
    await page.$eval("#extension-status", (el) => el.classList.contains("hidden")),
    true,
  );
});

console.log("status follows the selected chat:");
await withDashboard(async (page, stub) => {
  stub.broadcast(status("agent-2", "sample-extension", "other chat only"));
  await settle(page);
  expect("hidden while another chat is on screen", await statusTexts(page), []);
  await page.click('[data-agent-id="agent-2"]');
  await settle(page);
  expect("shown once you switch", await statusTexts(page), ["other chat only"]);
});

console.log("a widget pinned above the composer:");
await withDashboard(async (page, stub) => {
  const composerBefore = await page.$eval("#message-input", (el) => el.getBoundingClientRect().top);
  stub.broadcast(widgetEnvelope("agent-1", todoWidget(1, 3)));
  await settle(page);
  expect("shows the widget", await widgetKeys(page), ["todo-list"]);
  expect(
    "with the extension's own lines",
    (await widgetText(page))[0].includes("1/3 completed"),
    true,
  );
  expect(
    "themed by semantic colour, not raw ANSI",
    await page.$eval("#extension-widgets [data-widget-key]", (el) =>
      el.innerHTML.includes("text-base16-cyan"),
    ),
    true,
  );
  expect(
    "no escape codes leak into the text",
    (await widgetText(page))[0].includes("\u001b"),
    false,
  );
  expect(
    "it sits above the composer, not over it",
    await page.evaluate(() => {
      const strip = document.getElementById("extension-widgets").getBoundingClientRect();
      const input = document.getElementById("message-input").getBoundingClientRect();
      return strip.bottom <= input.top + 1 && strip.height > 0;
    }),
    true,
  );
  expect(
    "and the composer is still reachable",
    await page.evaluate((top) => document.getElementById("message-input").getBoundingClientRect().top <= top, composerBefore),
    true,
  );

  // An update replaces the widget rather than stacking a second copy.
  stub.broadcast(widgetEnvelope("agent-1", todoWidget(3, 3)));
  await settle(page);
  expect("an update replaces it", await widgetKeys(page), ["todo-list"]);
  expect("with the new content", (await widgetText(page))[0].includes("3/3 completed"), true);

  stub.broadcast(widgetEnvelope("agent-1", null));
  await settle(page);
  expect("null clears it", await widgetKeys(page), []);
  expect(
    "and the empty strip disappears",
    await page.$eval("#extension-widgets", (el) => el.classList.contains("hidden")),
    true,
  );
});

console.log("widgets are per chat, and can sit below the composer:");
await withDashboard(async (page, stub) => {
  stub.broadcast(widgetEnvelope("agent-2", todoWidget(0, 2)));
  await settle(page);
  expect("nothing shows for the other chat", await widgetKeys(page), []);
  await page.click('[data-agent-id="agent-2"]');
  await settle(page);
  expect("switching over reveals it", await widgetKeys(page), ["todo-list"]);
  await page.click('[data-agent-id="agent-1"]');
  await settle(page);
  expect("and it doesn't follow you back", await widgetKeys(page), []);

  stub.broadcast(widgetEnvelope("agent-1", todoWidget(1, 2, "belowEditor")));
  await settle(page);
  expect("belowEditor lands in the lower strip", await widgetKeys(page, "extension-widgets-below"), [
    "todo-list",
  ]);
  expect("and not the upper one", await widgetKeys(page), []);
});

if (failures.length > 0) {
  console.log("\n--- failures ---");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log("\nall extension UI checks passed");
process.exit(0);
