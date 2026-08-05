/**
 * Regression test for the "agent stuck in `running`, forever, having done
 * nothing" bug.
 *
 * `sendMessage` flips the agent to `running` before handing the text to
 * pi. When `prompt()` rejects *before the turn starts* — the classic case
 * being a model whose provider has no credentials on this host — pi never
 * emits `agent_end`, so nothing moved the agent back off `running`. The
 * dashboard showed a busy agent with zero tokens; the sender (often another
 * agent, which got a cheerful "✓ message sent" from `pru send`) had no way
 * to find out.
 *
 * Fix: a prompt that rejects without a turn having run parks the agent in
 * `error` with the reason.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentManager } from "../agent-manager.js";
import { ProjectManager } from "../project-manager.js";
import { StateManager } from "../state.js";
import type { AgentConfig } from "../types.js";

/** Fake pi session whose `prompt()` fails the way an unauthenticated
 *  provider does: rejects immediately, no events, never streaming. */
function makeFailingSession(error: Error) {
  return {
    isStreaming: false,
    _extensionRunner: { getCommand: () => undefined },
    prompt(): Promise<void> {
      return Promise.reject(error);
    },
    async steer(): Promise<void> {},
    async followUp(): Promise<void> {},
  };
}

/** Fake session that runs a turn and *then* fails, with pi's `agent_end`
 *  already having moved the agent to `waiting_input`. */
function makeLateFailingSession(error: Error, onStart: () => void) {
  return {
    isStreaming: false,
    _extensionRunner: { getCommand: () => undefined },
    async prompt(): Promise<void> {
      onStart();
      throw error;
    },
    async steer(): Promise<void> {},
    async followUp(): Promise<void> {},
  };
}

async function makeManager(agentId: string, session: unknown) {
  const dir = await mkdtemp(path.join(tmpdir(), "pirouette-test-"));
  const stateManager = new StateManager(dir);
  const projectManager = new ProjectManager(stateManager, dir);
  const manager = new AgentManager(stateManager, projectManager, dir);

  const config = {
    id: agentId,
    name: "child",
    projectName: "test",
    worktreePath: dir,
    state: "idle" as const,
    createdAt: Date.now(),
    sessionDir: dir,
  } as unknown as AgentConfig;
  stateManager.putAgent(config);

  const handle = {
    config,
    session: session as import("@earendil-works/pi-coding-agent").AgentSession,
    unsubscribe: () => {},
  };
  (manager as unknown as { handles: Map<string, typeof handle> }).handles.set(agentId, handle);

  return { manager, stateManager };
}

describe("AgentManager.sendMessage when the prompt never starts", () => {
  it("parks the agent in error instead of leaving it 'running'", async () => {
    const { manager, stateManager } = await makeManager(
      "child-1",
      makeFailingSession(new Error('No API key found for "anthropic".')),
    );

    await expect(manager.sendMessage("child-1", "go do the thing")).rejects.toThrow(
      /No API key/,
    );

    const config = stateManager.getAgent("child-1");
    expect(config?.state).toBe("error");
    expect(config?.errorMessage).toMatch(/No API key/);
  });

  it("broadcasts the error state so the dashboard stops showing a busy agent", async () => {
    const { manager } = await makeManager(
      "child-2",
      makeFailingSession(new Error("provider exploded")),
    );
    const states: string[] = [];
    manager.onStateChange((_id, state) => states.push(state));

    await expect(manager.sendMessage("child-2", "hi")).rejects.toThrow();

    expect(states).toEqual(["running", "error"]);
  });

  it("leaves a turn that actually ran to the event stream", async () => {
    // agent_end already reported waiting_input; a later rejection (a failed
    // retry after the turn produced output) must not rewrite that.
    let manager!: AgentManager;
    const session = makeLateFailingSession(new Error("stream aborted"), () => {
      (
        manager as unknown as { setAgentState(id: string, s: string): void }
      ).setAgentState("child-3", "waiting_input");
    });
    const made = await makeManager("child-3", session);
    manager = made.manager;

    await expect(manager.sendMessage("child-3", "hi")).rejects.toThrow();

    expect(made.stateManager.getAgent("child-3")?.state).toBe("waiting_input");
  });
});
