// @vitest-environment jsdom
// The selected chat is kept in the URL hash so a reload reopens it.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let socket;

function makeAgent(id) {
  return {
    id, name: id, projectName: "scratchpad", state: "waiting_input", model: "demo-model",
    createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

function broadcast(envelope) {
  socket.onmessage({ data: JSON.stringify(envelope) });
}

const title = () => document.getElementById("agent-title").textContent;
const agentParam = () => new URLSearchParams(location.hash.slice(1)).get("agent");

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  document.documentElement.innerHTML = readFileSync(resolve(here, "../index.html"), "utf8");
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal("WebSocket", class {
    constructor() { socket = this; }
  });
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    let data = {};
    if (url.endsWith("/messages")) data = { messages: [] };
    else if (url.endsWith("/stats")) data = { stats: null };
    else if (url === "/api/skills") data = { skills: [] };
    else if (url === "/api/commands") data = { commands: [] };
    else if (url === "/themes.json") data = [];
    return { ok: true, json: async () => data };
  }));
  // As if the page was reloaded while "second" was open.
  history.replaceState(null, "", "/#agent=second");
  await import("../app.js");
  broadcast({ kind: "projects_list", projects: [{ name: "scratchpad" }] });
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("selected chat in the URL hash", () => {
  it("reopens the chat named in the hash once the agent list arrives", () => {
    broadcast({ kind: "agents_list", agents: [makeAgent("first"), makeAgent("second")] });
    expect(title()).toContain("second");
    expect(agentParam()).toBe("second");
  });

  it("does not move the selection when a later agents_list arrives", () => {
    document.querySelector('[data-agent-id="first"]').click();
    broadcast({ kind: "agents_list", agents: [makeAgent("first"), makeAgent("second")] });
    expect(title()).toContain("first");
  });

  it("writes the hash when a chat is clicked, without adding history entries", () => {
    const before = history.length;
    document.querySelector('[data-agent-id="second"]').click();
    expect(agentParam()).toBe("second");
    document.querySelector('[data-agent-id="first"]').click();
    expect(agentParam()).toBe("first");
    expect(history.length).toBe(before);
  });

  it("switches chats when the hash is changed by hand", () => {
    location.hash = "agent=second";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(title()).toContain("second");
  });

  it("clears the hash when the selected chat is removed", () => {
    broadcast({ kind: "agent_removed", agentId: "second" });
    expect(agentParam()).toBeNull();
  });
});
