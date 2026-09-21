// @vitest-environment jsdom
// Regression: compaction errors must survive both event normalization and
// the dashboard's asynchronous history refresh, rather than flash and vanish.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeEvent } from "../../server/normalize.ts";

let socket;
let agent;
let nextId = 0;
const projects = [{ name: "scratchpad" }];
const row = () => document.querySelector('[data-msg-key="compaction"]');
const broadcast = (envelope) => socket.onmessage({ data: JSON.stringify(envelope) });
const emit = (event, agentId = agent.id) => broadcast({ kind: "agent_event", agentId, event });
const select = (id) => document.querySelector(`[data-agent-id="${id}"]`).click();
const historyCalls = () => fetch.mock.calls.filter(([url]) => url.endsWith("/messages"));

function makeAgent() {
  const id = `compaction-test-${++nextId}`;
  return {
    id, name: id, projectName: "scratchpad", state: "waiting_input", model: "demo-model",
    createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  document.documentElement.innerHTML = readFileSync(resolve(here, "../index.html"), "utf8");
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal("WebSocket", class { constructor() { socket = this; } });
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    let data = {};
    if (url.endsWith("/messages")) data = { messages: [{ role: "user", content: "hello", ts: 1 }] };
    else if (url.endsWith("/stats")) data = { stats: null };
    else if (url === "/api/skills") data = { skills: [] };
    else if (url === "/api/commands") data = { commands: [] };
    else if (url === "/themes.json") data = [];
    return { ok: true, json: async () => data };
  }));
  await import("../app.js");
});

beforeEach(async () => {
  agent = makeAgent();
  broadcast({ kind: "projects_list", projects });
  broadcast({ kind: "agents_list", agents: [agent] });
  select(agent.id);
  await vi.waitFor(() => expect(document.getElementById("messages").textContent).toContain("hello"));
  fetch.mockClear();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("compaction feedback in the dashboard", () => {
  it("shows a normalized SDK failure and keeps it after the agent settles", async () => {
    const errorMessage = "Auto-compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete";
    emit({ type: "compaction_start", reason: "threshold" });
    expect(row().textContent).toContain("compacting context");
    emit(normalizeEvent({
      type: "compaction_end", reason: "threshold", result: undefined,
      aborted: false, willRetry: false, errorMessage,
    }));
    expect(row().textContent).toContain(errorMessage);
    expect(row().textContent).not.toContain("context compacted");
    expect(historyCalls()).toHaveLength(0);

    broadcast({ kind: "agent_state_change", agentId: agent.id, state: "waiting_input" });
    await vi.waitFor(() => expect(historyCalls()).toHaveLength(1));
    // Allow both fetch and response.json to settle, including the re-render.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(row().textContent).toContain(errorMessage);
  });

  it("refreshes successful compaction history without losing the outcome", async () => {
    emit(normalizeEvent({
      type: "compaction_end", reason: "manual", aborted: false, willRetry: false,
      result: { summary: "summary", firstKeptEntryId: "kept", tokensBefore: 120000, estimatedTokensAfter: 23000 },
    }));
    await vi.waitFor(() => expect(historyCalls()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(row().textContent).toContain("context compacted (manual)");
    expect(row().textContent).toContain("120,000 → ~23,000 tokens");
  });

  it("retains a background agent's failure when its history is first opened", async () => {
    const background = makeAgent();
    broadcast({ kind: "agent_created", agent: background });
    emit({
      type: "compaction_end", reason: "overflow", aborted: false, willRetry: false,
      errorMessage: "Context overflow recovery failed: summary too long",
    }, background.id);
    select(background.id);
    await vi.waitFor(() => expect(historyCalls()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(row().textContent).toContain("compaction failed (context recovery)");
    expect(row().textContent).toContain("summary too long");
  });

  it("does not refresh history or claim success after cancellation", () => {
    emit({ type: "compaction_end", reason: "manual", aborted: true, willRetry: false });
    expect(historyCalls()).toHaveLength(0);
    expect(row().textContent).toContain("compaction aborted");
    expect(row().textContent).not.toContain("context compacted");
  });
});
