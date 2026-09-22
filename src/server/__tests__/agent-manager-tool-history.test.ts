import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../agent-manager.js";

const handleEvent = (AgentManager.prototype as unknown as {
  handleAgentEvent(agentId: string, event: AgentSessionEvent): void;
}).handleAgentEvent;

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

function harness() {
  const messages: unknown[] = [
    { role: "assistant", timestamp: 1, content: [
      { type: "toolCall", id: "a", name: "read", arguments: { path: "file.ts" } },
      { type: "toolCall", id: "b", name: "bash", arguments: { command: "pwd" } },
    ] },
  ];
  const handle = { session: { messages }, activeToolCalls: new Set<string>() };
  const manager = {
    handles: new Map([["test-agent", handle]]), emitEvent: vi.fn(), setAgentState: vi.fn(),
    stateManager: { updateAgentState: vi.fn() },
  } as unknown as AgentManager;
  return {
    messages,
    emit: (event: unknown) => handleEvent.call(manager, "test-agent", event as AgentSessionEvent),
    history: () => AgentManager.prototype.getMessages.call(manager, "test-agent"),
  };
}

describe("tool history for expandable dashboard output", () => {
  it("preserves output beyond the old 2000-character limit", () => {
    const h = harness();
    const text = "full output\n".repeat(1000);
    h.messages.push({ role: "toolResult", toolName: "read", toolCallId: "a", timestamp: 2, content: [{ type: "text", text }] });
    expect(h.history().at(-1)?.content).toBe(text);
  });

  it("does not synthesize output for empty successful results", () => {
    const h = harness();
    h.messages.push({ role: "toolResult", toolName: "read", toolCallId: "a", timestamp: 2, content: [] });
    expect(h.history().at(-1)?.content).toBe("");
  });

  it("includes only actually running calls after a history reload", () => {
    const h = harness();
    h.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "a", args: {} });
    expect(h.history().map((m) => m.toolStatus)).toEqual(["running", undefined]);
    h.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "b", args: {} });
    h.emit({ type: "tool_execution_end", toolName: "read", toolCallId: "a", result: { content: [] }, isError: false });
    expect(h.history().map((m) => m.toolStatus)).toEqual([undefined, "running"]);
    h.emit({ type: "agent_end", messages: [] });
    expect(h.history().map((m) => m.toolStatus)).toEqual([undefined, undefined]);
  });
});
