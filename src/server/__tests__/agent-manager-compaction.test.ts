import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../agent-manager.js";

const handleEvent = (AgentManager.prototype as unknown as {
  handleAgentEvent(agentId: string, event: AgentSessionEvent): void;
}).handleAgentEvent;

afterEach(() => vi.restoreAllMocks());

function dispatch(event: AgentSessionEvent) {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const emitEvent = vi.fn();
  const updateAgentState = vi.fn();
  // No live session needed: exercise the normal event handler's logging,
  // normalization, and activity bookkeeping without making any API calls.
  handleEvent.call({ emitEvent, stateManager: { updateAgentState } } as unknown as AgentManager, "test-agent", event);
  return { error, emitEvent, updateAgentState };
}

describe("compaction failure logging", () => {
  it.each(["manual", "threshold", "overflow"] as const)("logs and broadcasts %s failures", (reason) => {
    const errorMessage = "Summarization failed: generation hit the token cap and the summary is incomplete";
    const { error, emitEvent, updateAgentState } = dispatch({
      type: "compaction_end", reason, result: undefined, aborted: false, willRetry: false, errorMessage,
    });
    expect(error).toHaveBeenCalledWith(`[agent-manager] compaction failed for test-agent (${reason}): ${errorMessage}`);
    expect(emitEvent).toHaveBeenCalledWith("test-agent", expect.objectContaining({ errorMessage }));
    // A failed compaction doesn't mean the session itself has stopped.
    expect(updateAgentState).toHaveBeenCalledExactlyOnceWith("test-agent", { lastActivity: expect.any(String) });
  });

  it("does not report cancellation as a failure", () => {
    const { error } = dispatch({
      type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false,
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("does not log a successful summary or its contents", () => {
    const { error, emitEvent } = dispatch({
      type: "compaction_end", reason: "threshold", aborted: false, willRetry: false,
      result: { summary: "summary contents", firstKeptEntryId: "kept", tokensBefore: 120000, estimatedTokensAfter: 23000 },
    });
    expect(error).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith("test-agent", expect.objectContaining({
      result: { tokensBefore: 120000, estimatedTokensAfter: 23000 },
    }));
  });
});
