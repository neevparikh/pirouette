// @vitest-environment jsdom
// Events broadcast while the socket is down are lost, so a reconnect has
// to refetch the open chat instead of waiting for the agent's next turn.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sockets = [];
let serverMessages = [];

function makeAgent(id, state = "waiting_input") {
  return {
    id, name: id, projectName: "scratchpad", state, model: "demo-model",
    createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

const latest = () => sockets[sockets.length - 1];
function broadcast(envelope, socket = latest()) {
  socket.onmessage({ data: JSON.stringify(envelope) });
}
function userText(text) {
  return { role: "user", content: text, ts: text };
}
const transcriptText = () => document.getElementById("messages").textContent;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  document.documentElement.innerHTML = readFileSync(resolve(here, "../index.html"), "utf8");
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {} }));
  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor() {
      this.readyState = FakeSocket.CONNECTING;
      sockets.push(this);
    }
    open() {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    }
    close() {
      this.readyState = FakeSocket.CLOSED;
      this.onclose?.();
    }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    let data = {};
    if (url.endsWith("/messages")) data = { messages: serverMessages };
    else if (url.endsWith("/stats")) data = { stats: null };
    else if (url.endsWith("/bash")) data = { running: [] };
    else if (url === "/api/skills") data = { skills: [] };
    else if (url === "/api/commands") data = { commands: [] };
    else if (url === "/themes.json") data = [];
    return { ok: true, json: async () => data };
  }));
  await import("../app.js");
  latest().open();
  broadcast({ kind: "projects_list", projects: [{ name: "scratchpad" }] });
  broadcast({ kind: "agents_list", agents: [makeAgent("a")] });
  serverMessages = [userText("before sleep")];
  document.querySelector('[data-agent-id="a"]').click();
  await flush();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("websocket reconnect", () => {
  it("refetches the open chat after a reconnect", async () => {
    expect(transcriptText()).toContain("before sleep");

    // Socket dies; the agent does more work while nobody is listening.
    const dead = latest();
    dead.close();
    serverMessages = [userText("before sleep"), userText("while asleep")];

    // Coming back to the tab reconnects without waiting on the retry timer.
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(latest()).not.toBe(dead);

    latest().open();
    broadcast({ kind: "agents_list", agents: [makeAgent("a")] });
    await flush();
    expect(transcriptText()).toContain("while asleep");
  });

  it("does not refetch on an agents_list that isn't from a reconnect", async () => {
    const calls = fetch.mock.calls.length;
    broadcast({ kind: "agents_list", agents: [makeAgent("a")] });
    await flush();
    expect(fetch.mock.calls.slice(calls).some(([u]) => u.endsWith("/messages"))).toBe(false);
  });

  it("does not open a second socket when the old one's close lands late", () => {
    const count = sockets.length;
    const old = latest();
    old.readyState = WebSocket.CLOSED; // closed, but onclose not yet delivered
    window.dispatchEvent(new Event("online"));
    expect(sockets.length).toBe(count + 1);
    vi.useFakeTimers();
    old.onclose();
    vi.advanceTimersByTime(5000);
    vi.useRealTimers();
    expect(sockets.length).toBe(count + 1);
  });
});
