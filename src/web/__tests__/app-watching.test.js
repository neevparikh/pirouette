// @vitest-environment jsdom
// The chat list's status dot tells an agent that is waiting on a watch
// (`pru watch`) apart from one that is waiting on you.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sockets = [];

function makeAgent(id, state = "waiting_input") {
  return {
    id, name: id, projectName: "scratchpad", state, model: "demo-model",
    createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

function broadcast(envelope) {
  sockets[sockets.length - 1].onmessage({ data: JSON.stringify(envelope) });
}
const row = (id) => document.querySelector(`[data-agent-id="${id}"]`);
const dot = (id) => row(id).querySelector("span.rounded-full");

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
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    let data = {};
    if (url === "/api/skills") data = { skills: [] };
    else if (url === "/api/commands") data = { commands: [] };
    else if (url === "/themes.json") data = [];
    return { ok: true, json: async () => data };
  }));
  await import("../app.js");
  sockets[sockets.length - 1].open();
  broadcast({ kind: "projects_list", projects: [{ name: "scratchpad" }] });
  broadcast({
    kind: "agents_list",
    agents: [makeAgent("watcher"), makeAgent("idler"), makeAgent("busy", "running")],
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("status dot for agents waiting on a watch", () => {
  it("marks only the finished agents that have a watch", () => {
    broadcast({ kind: "agent_watches", counts: { watcher: 2, busy: 1 } });
    expect(dot("watcher").dataset.watching).toBe("1");
    expect(dot("watcher").className).toContain("border-base16-blue");
    expect(dot("watcher").className).not.toContain("bg-base16-orange");
    expect(row("watcher").title).toContain("waiting on 2 watches");

    expect(dot("idler").dataset.watching).toBeUndefined();
    expect(dot("idler").className).toContain("bg-base16-orange");
    expect(row("idler").title).toContain("your turn");

    expect(dot("busy").dataset.watching).toBeUndefined();
    expect(dot("busy").className).toContain("bg-base16-green");
  });

  it("switches as the agent starts and finishes a turn", () => {
    broadcast({ kind: "agent_state_change", agentId: "busy", state: "waiting_input" });
    expect(dot("busy").dataset.watching).toBe("1");
    expect(row("busy").title).toMatch(/waiting on 1 watch$/);
    broadcast({ kind: "agent_state_change", agentId: "watcher", state: "running" });
    expect(dot("watcher").dataset.watching).toBeUndefined();
  });

  it("goes back to the plain dot when the last watch is gone", () => {
    broadcast({ kind: "agent_watches", counts: {} });
    expect(dot("busy").dataset.watching).toBeUndefined();
    expect(dot("busy").className).toContain("bg-base16-orange");
  });
});
