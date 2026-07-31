#!/usr/bin/env node
// scripts/check-sidebar.mjs
//
// End-to-end check for the resizable chat sidebar, run against a real
// browser. The parts worth checking can't be unit-tested: whether a drag
// actually moves the column, whether the width survives a reload (and
// arrives before the first paint), whether the clamps hold, and whether a
// desktop width leaks into the mobile drawer.
//
// Serves src/web/ over a stub backend (one project, one agent) and drives
// Chromium:
//
//   node scripts/check-sidebar.mjs
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
  name: "a-chat-with-a-fairly-long-name",
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

async function startStubServer() {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path.startsWith("/api/")) {
      let body = {};
      if (path === "/api/agents") body = [AGENT];
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
    ws.send(JSON.stringify({ kind: "agents_list", agents: [AGENT] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
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

async function withDashboard(body, { viewport = { width: 1280, height: 800 } } = {}) {
  const stub = await startStubServer();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  try {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (err) => failures.push(`page error: ${err.message}`));
    const url = `http://127.0.0.1:${stub.port}/`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-agent-id]");
    await body(page, url);
  } finally {
    await browser.close();
    await stub.close();
  }
}

const sidebarWidth = (page) =>
  page.evaluate(() =>
    Math.round(document.getElementById("chat-sidebar").getBoundingClientRect().width));
const savedWidth = (page) =>
  page.evaluate(() => localStorage.getItem("pirouette-sidebar-width"));

/** Drag the handle by `dx` px. */
async function dragHandle(page, dx) {
  const box = await page.locator("#sidebar-resizer").boundingBox();
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Two moves: pointer capture only starts tracking after the first one,
  // and a single jump is a less honest imitation of a real drag.
  await page.mouse.move(x + dx / 2, y, { steps: 5 });
  await page.mouse.move(x + dx, y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

console.log("dragging the handle:");
await withDashboard(async (page) => {
  expect("starts at the stock width", await sidebarWidth(page), 256);
  await dragHandle(page, 140);
  expect("follows the pointer", await sidebarWidth(page), 396);
  expect("and records the preference", await savedWidth(page), "396");
});

console.log("the width survives a reload:");
await withDashboard(async (page, url) => {
  await dragHandle(page, 120);
  expect("wider", await sidebarWidth(page), 376);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-agent-id]");
  expect("still wider after a reload", await sidebarWidth(page), 376);
  // The <head> script is what makes this true; without it the column
  // paints at 256 and jumps once the module runs.
  expect(
    "and was applied before the first paint",
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--sidebar-width")),
    "376px",
  );
});

console.log("clamps:");
await withDashboard(async (page) => {
  await dragHandle(page, -400);
  expect("can't be dragged away", await sidebarWidth(page), 176);
  await dragHandle(page, 2000);
  expect("can't swallow the chat column", await sidebarWidth(page), 640);
});

console.log("double-click resets:");
await withDashboard(async (page) => {
  await dragHandle(page, 150);
  expect("wider", await sidebarWidth(page), 406);
  await page.locator("#sidebar-resizer").dblclick();
  await page.waitForTimeout(150);
  expect("back to the stock width", await sidebarWidth(page), 256);
  expect("and remembered as such", await savedWidth(page), "256");
});

console.log("keyboard resizing:");
await withDashboard(async (page) => {
  await page.locator("#sidebar-resizer").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(100);
  expect("two steps wider", await sidebarWidth(page), 288);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(100);
  expect("one step back", await sidebarWidth(page), 272);
  await page.keyboard.press("Home");
  await page.waitForTimeout(100);
  expect("home resets", await sidebarWidth(page), 256);
});

// A desktop width must not follow the user down to a phone, where the
// sidebar is a fixed-position drawer with its own width. This is the case
// an inline style on the element would get wrong.
console.log("a wide desktop sidebar doesn't leak into the mobile drawer:");
await withDashboard(async (page) => {
  await dragHandle(page, 300);
  expect("wide on desktop", await sidebarWidth(page), 556);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  // The drawer's own `min(85vw, 320px)`, not the 556 from the drag.
  expect("drawer keeps its own width", await sidebarWidth(page), 320);
  expect("handle is hidden", await page.locator("#sidebar-resizer").isVisible(), false);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(250);
  expect("and the preference comes back on the way out", await sidebarWidth(page), 556);
});

// Half of a small window is less than the stored width: the sidebar is
// re-fitted for as long as the window is small, without losing the
// preference.
console.log("a window too narrow for the saved width:");
await withDashboard(async (page) => {
  await dragHandle(page, 300);
  expect("saved", await savedWidth(page), "556");
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(250);
  expect("re-fitted to half the window", await sidebarWidth(page), 450);
  expect("preference untouched", await savedWidth(page), "556");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(250);
  expect("restored when there's room again", await sidebarWidth(page), 556);
});

if (failures.length > 0) {
  console.log("\n--- failures ---");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log("\nall sidebar checks passed");
process.exit(0);
