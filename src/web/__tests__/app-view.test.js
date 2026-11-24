// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let socket;
const agent = {
  id: "view-1", name: "view-1", projectName: "scratchpad", state: "running",
  model: "demo", createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
};
const messages = () => document.getElementById("messages");
const rowKeys = () => [...messages().children].map((el) => el.getAttribute("data-msg-key"));
const broadcast = (envelope) => socket.onmessage({ data: JSON.stringify(envelope) });
const emit = (event) => broadcast({ kind: "agent_event", agentId: agent.id, event });
const nextFrame = () => new Promise((resolve) => (globalThis.requestAnimationFrame ?? setTimeout)(resolve, 16));
const picker = () => document.getElementById("view-picker");
const pick = (selector) => picker().querySelector(selector).click();

beforeAll(async () => {
  document.documentElement.innerHTML = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../index.html"), "utf8");
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal("WebSocket", class { constructor() { socket = this; } });
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    let data = {};
    if (url.endsWith("/messages")) data = { messages: [{ role: "user", content: "go", ts: 1 }] };
    else if (url.endsWith("/stats")) data = { stats: null };
    else if (url === "/api/skills") data = { skills: [] };
    else if (url === "/api/commands") data = { commands: [] };
    else if (url === "/themes.json") data = [];
    return { ok: true, json: async () => data };
  }));
  localStorage.clear();
  await import("../app.js");
  broadcast({ kind: "projects_list", projects: [{ name: "scratchpad" }] });
  broadcast({ kind: "agents_list", agents: [agent] });
  document.querySelector(`[data-agent-id="${agent.id}"]`).click();
  await vi.waitFor(() => expect(messages().textContent).toContain("go"));
});

afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("transcript view picker", () => {
  it("folds hidden rows, remembers the choice, and opens a fold on click", async () => {
    emit({ type: "message_start", role: "assistant" });
    emit({ type: "message_update", updateType: "thinking_delta", delta: "plan" });
    emit({ type: "message_update", updateType: "text_delta", delta: "Looking." });
    emit({ type: "message_end", role: "assistant" });
    emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "c1", args: { command: "pwd" } });
    emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "c1", result: { content: [{ type: "text", text: "/tmp" }] } });
    emit({ type: "message_start", role: "assistant" });
    emit({ type: "message_update", updateType: "text_delta", delta: "Done." });
    emit({ type: "message_end", role: "assistant" });
    expect(rowKeys()).toEqual(["msg:0", "msg:1", "msg:2", "tc:c1:tool", "tc:c1:tool_result", "msg:5"]);

    const button = document.getElementById("agent-view-btn");
    button.click();
    expect(picker().classList.contains("hidden")).toBe(false);
    pick('[data-view-kind="tools"]');
    expect(rowKeys()).toEqual(["msg:0", "msg:1", "msg:2", "fold:tc:c1:tool", "msg:5"]);
    expect(JSON.parse(localStorage.getItem("pirouette-view-hidden"))).toEqual(["tools"]);
    // The picker stays open across choices and reflects them.
    expect(picker().querySelector('[data-view-kind="tools"]').getAttribute("aria-checked")).toBe("false");

    pick("[data-view-outputs]");
    expect(rowKeys()).toEqual(["msg:0", "fold:msg:1", "msg:5"]);
    expect(messages().textContent).toContain("Done.");
    expect(messages().textContent).not.toContain("Looking.");
    expect(button.title).toContain("Hiding thinking, tool calls, interim messages");

    messages().querySelector('[data-toggle="fold:msg:1"]').click();
    expect(rowKeys()).toEqual(["msg:0", "fold:msg:1", "msg:1", "msg:2", "tc:c1:tool", "tc:c1:tool_result", "msg:5"]);
    messages().querySelector('[data-toggle="fold:msg:1"]').click();

    // Hidden thinking doesn't draw a bubble while it streams.
    emit({ type: "message_start", role: "assistant" });
    emit({ type: "message_update", updateType: "thinking_delta", delta: "more" });
    await nextFrame();
    expect(rowKeys()).toEqual(["msg:0", "fold:msg:1", "msg:5"]);
    emit({ type: "message_end", role: "assistant" });

    pick("[data-view-outputs]");
    expect(rowKeys()).toHaveLength(7);
    expect(localStorage.getItem("pirouette-view-hidden")).toBe("[]");
    document.body.click();
    expect(picker().classList.contains("hidden")).toBe(true);
  });
});
