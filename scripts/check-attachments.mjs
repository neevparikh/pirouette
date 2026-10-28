#!/usr/bin/env node
// scripts/check-attachments.mjs
//
// End-to-end check for prompt attachments in the dashboard composer, run
// against a real browser: the "attach" picker, drag-and-drop onto the
// input bar, and pasting files. Images go inline with the message; other
// files are uploaded to /api/uploads and their paths appended to the text.
//
// Serves src/web/ over a stub backend (one project, one idle agent) that
// records uploads and sent messages, and drives Chromium:
//
//   node scripts/check-attachments.mjs
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
const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

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

/** Stub backend. Uploads whose name starts with `fail` 500; `slow` ones
 *  take 1.5s. */
async function startStubServer() {
  const uploads = [];
  const messages = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    if (req.method === "POST" && path === "/api/uploads") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const name = url.searchParams.get("name");
      const size = Buffer.concat(chunks).length;
      uploads.push({ name, size, contentType: req.headers["content-type"] });
      if (name.startsWith("slow")) await new Promise((r) => setTimeout(r, 1500));
      if (name.startsWith("fail")) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "disk full" }));
        return;
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: `/data/uploads/2026-05-03/abcd1234-${name}`, name, size }));
      return;
    }
    if (req.method === "POST" && path === `/api/agents/${AGENT_ID}/message`) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      messages.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
      return;
    }
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
    uploads,
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

const pills = (page) =>
  page.evaluate(() => ({
    images: document.querySelectorAll("#attachment-strip [data-remove-image]").length,
    files: [...document.querySelectorAll("#attachment-strip [data-remove-file]")].map((b) =>
      b.parentElement.textContent.replace(/\s+/g, " ").replace("×", "").trim(),
    ),
  }));
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
const NOTE = "[Attached files — saved on this host; read them from these paths]";

console.log("attach picker: one image, one text file:");
await withDashboard(async (page, stub) => {
  expect("attach button visible", await page.locator("#attach-btn").isVisible(), true);
  const chooser = page.waitForEvent("filechooser");
  await page.click("#attach-btn");
  await (await chooser).setFiles([
    { name: "dot.png", mimeType: "image/png", buffer: ONE_PX_PNG },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello world") },
  ]);
  await waitFor(async () => (await pills(page)).files.some((f) => f.includes("11 B")));
  expect("strip shows both", await pills(page), { images: 1, files: ["notes.txt 11 B"] });
  expect("text file uploaded as octet-stream", stub.uploads, [
    { name: "notes.txt", size: 11, contentType: "application/octet-stream" },
  ]);
  await page.keyboard.type("look at these");
  await page.keyboard.press("Enter");
  await waitFor(() => stub.messages.length > 0);
  const msg = stub.messages[0];
  expect(
    "message text carries the upload path",
    msg?.message,
    `look at these\n\n${NOTE}\n- /data/uploads/2026-05-03/abcd1234-notes.txt (notes.txt, 11 B)`,
  );
  expect("image sent inline", msg?.images?.map((i) => i.mimeType), ["image/png"]);
  expect("strip cleared after send", await pills(page), { images: 0, files: [] });
  expect("transcript shows the note", await page.locator("#messages").textContent().then((t) => t.includes("abcd1234-notes.txt")), true);
});

console.log("drag and drop onto the input bar:");
await withDashboard(async (page, stub) => {
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["a,b\n1,2\n"], "data.csv", { type: "text/csv" }));
    const bar = document.getElementById("input-bar");
    bar.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    bar.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await waitFor(() => stub.uploads.length > 0);
  expect("dropped file uploaded", stub.uploads.map((u) => u.name), ["data.csv"]);
  await page.keyboard.press("Enter");
  await waitFor(() => stub.messages.length > 0);
  expect("file-only message is just the note", stub.messages[0]?.message.startsWith(NOTE), true);
});

console.log("pasting a non-image file:");
await withDashboard(async (page, stub) => {
  const prevented = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["%PDF-1.4"], "paper.pdf", { type: "application/pdf" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.getElementById("message-input").dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  await waitFor(() => stub.uploads.length > 0);
  expect("paste intercepted", prevented, true);
  expect("pasted file uploaded", stub.uploads.map((u) => u.name), ["paper.pdf"]);
  expect("textarea untouched", await page.inputValue("#message-input"), "");
});

console.log("sending while an upload is still in flight waits for it:");
await withDashboard(async (page, stub) => {
  const chooser = page.waitForEvent("filechooser");
  await page.click("#attach-btn");
  await (await chooser).setFiles([{ name: "slow.log", mimeType: "text/plain", buffer: Buffer.from("x") }]);
  expect("shows uploading", (await pills(page)).files, ["slow.log uploading…"]);
  await page.focus("#message-input");
  await page.keyboard.type("go");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  expect("not sent yet", stub.messages.length, 0);
  await waitFor(() => stub.messages.length > 0);
  expect("sent once the upload landed", stub.messages[0]?.message.includes("abcd1234-slow.log"), true);
});

console.log("a failed upload blocks the send until removed:");
await withDashboard(async (page, stub) => {
  const alerts = [];
  page.on("dialog", (d) => {
    alerts.push(d.message());
    d.dismiss();
  });
  const chooser = page.waitForEvent("filechooser");
  await page.click("#attach-btn");
  await (await chooser).setFiles([{ name: "fail.bin", mimeType: "application/octet-stream", buffer: Buffer.from("x") }]);
  await waitFor(async () => (await pills(page)).files.some((f) => f.includes("failed")));
  expect("marked failed", (await pills(page)).files, ["fail.bin failed"]);
  await page.focus("#message-input");
  await page.keyboard.type("keep me");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  expect("alerted", alerts.length === 1 && alerts[0].includes("disk full"), true);
  expect("nothing sent", stub.messages.length, 0);
  expect("draft kept", await page.inputValue("#message-input"), "keep me");
  await page.click("#attachment-strip [data-remove-file]");
  await page.focus("#message-input");
  await page.keyboard.press("Enter");
  await waitFor(() => stub.messages.length > 0);
  expect("sent without the file", stub.messages[0]?.message, "keep me");
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nall attachment checks passed");
