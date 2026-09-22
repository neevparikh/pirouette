// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let socket;
let agent;
let nextId = 0;
const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
const messages = () => document.getElementById("messages");
const broadcast = (envelope) => socket.onmessage({ data: JSON.stringify(envelope) });
const emit = (event) => broadcast({ kind: "agent_event", agentId: agent.id, event });
const makeAgent = () => ({
  id: `preview-${++nextId}`, name: `preview-${nextId}`, projectName: "scratchpad", state: "running",
  model: "demo", createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
});

beforeAll(async () => {
  document.documentElement.innerHTML = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../index.html"), "utf8");
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal("WebSocket", class { constructor() { socket = this; } });
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    let data = {};
    if (url.endsWith("/messages")) data = { messages: [{ role: "user", content: text, ts: 1 }] };
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
  broadcast({ kind: "projects_list", projects: [{ name: "scratchpad" }] });
  broadcast({ kind: "agents_list", agents: [agent] });
  document.querySelector(`[data-agent-id="${agent.id}"]`).click();
  await vi.waitFor(() => expect(messages().textContent).toContain("line 1"));
});

afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("dashboard preview controls", () => {
  it("expands output through the delegated button and preserves keyboard focus", () => {
    emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "c1", args: { command: "pwd" } });
    expect(messages().querySelector(".tool-status-running")).not.toBeNull();
    emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "c1", result: { content: [{ type: "text", text }] } });
    expect(messages().querySelector(".tool-status-running")).toBeNull();
    expect(messages().querySelectorAll(".tool-status-completed")).toHaveLength(2);
    const selector = '[data-toggle="tc:c1:tool_result"]';
    expect(messages().querySelector(".pi-row-tool-result code").textContent).not.toContain("line 9");
    messages().querySelector(selector).click();
    expect(document.activeElement).toBe(messages().querySelector(selector));
    expect(messages().querySelector(".pi-row-tool-result code").textContent).toBe(text);
    emit({ type: "message_update", updateType: "text_delta", delta: "hello" });
    expect(messages().querySelector(selector).getAttribute("aria-expanded")).toBe("true");
    messages().querySelector(selector).click();
    expect(messages().querySelector(".pi-row-tool-result code").textContent).not.toContain("line 9");
  });

  it("renders streamed thinking Markdown on the initial and incremental paths", () => {
    emit({ type: "message_start", role: "assistant" });
    emit({ type: "message_update", updateType: "thinking_delta", delta: "**plan**\n\n" });
    expect(messages().querySelector(".thinking-content strong, .thinking-content .pi-strong")).not.toBeNull();
    emit({ type: "message_update", updateType: "thinking_delta", delta: text });
    const selector = '[data-toggle="streaming-thinking"]';
    messages().querySelector(selector).click();
    emit({ type: "message_update", updateType: "thinking_delta", delta: "\n\n**next**" });
    expect(messages().querySelector(selector).getAttribute("aria-expanded")).toBe("true");
    expect(messages().querySelectorAll(".thinking-content strong, .thinking-content .pi-strong")).toHaveLength(2);
    expect(document.activeElement).toBe(messages().querySelector(selector));
    emit({ type: "message_end", role: "assistant" });
    expect(messages().querySelector("#streaming-thinking-body")).toBeNull();
    expect(messages().querySelector('.pi-row-thinking button').getAttribute("aria-expanded")).toBe("true");
    expect(messages().querySelector(".thinking-content").textContent).toContain("next");
  });

  it("keeps a user's expansion local to its agent", async () => {
    const first = agent;
    messages().querySelector('.pi-row-user button').click();
    expect(messages().querySelector('.pi-row-user button').getAttribute("aria-expanded")).toBe("true");
    const other = makeAgent();
    broadcast({ kind: "agent_created", agent: other });
    document.querySelector(`[data-agent-id="${other.id}"]`).click();
    await vi.waitFor(() => expect(messages().querySelector('.pi-row-user button')).not.toBeNull());
    expect(messages().querySelector('.pi-row-user button').getAttribute("aria-expanded")).toBe("false");
    document.querySelector(`[data-agent-id="${first.id}"]`).click();
    await vi.waitFor(() => expect(messages().querySelector('.pi-row-user button').getAttribute("aria-expanded")).toBe("true"));
  });

  it("clears a stale running badge when a session is stopped", () => {
    emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "c1", args: { command: "pwd" } });
    broadcast({ kind: "agent_state_change", agentId: agent.id, state: "stopped" });
    expect(messages().querySelector(".tool-status-running")).toBeNull();
    expect(messages().querySelector(".pi-row-tool-call").textContent).toContain("No result");
  });
});
