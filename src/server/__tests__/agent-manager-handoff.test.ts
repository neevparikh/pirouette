/**
 * Handing an agent's work over to a fresh successor.
 *
 * The load-bearing property is that the successor lands in the *same*
 * worktree — that's what makes a handoff different from a fork (copies the
 * conversation, new worktree) or a plain launch (new worktree off the
 * default branch). Uncommitted work has to survive the swap, the outgoing
 * chat has to get out of the sidebar, and deleting either agent later must
 * not take the shared worktree with it.
 *
 * `startSession` is stubbed out: it builds a real pi session (model
 * registry, auth, extensions) which has no business running in a unit test.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentManager, nextHandoffName } from "../agent-manager.js";
import { ProjectManager } from "../project-manager.js";
import { StateManager } from "../state.js";
import type { AgentConfig, ProjectConfig, WsEnvelope } from "../types.js";

function makeFakeSession() {
  const calls: string[] = [];
  return {
    calls,
    get isStreaming() {
      return false;
    },
    async abort(): Promise<void> {
      calls.push("abort");
    },
    dispose(): void {
      calls.push("dispose");
    },
    async prompt(text: string): Promise<void> {
      calls.push(`prompt:${text}`);
    },
  };
}

async function makeManager() {
  const dir = await mkdtemp(path.join(tmpdir(), "pirouette-handoff-test-"));
  const stateManager = new StateManager(dir);
  const projectManager = new ProjectManager(stateManager, dir);
  const manager = new AgentManager(stateManager, projectManager, dir);

  stateManager.putProject({
    name: "proj",
    repoUrl: null,
    repoPath: path.join(dir, "repo"),
    worktreesDir: path.join(dir, "worktrees"),
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  } as ProjectConfig);

  const parent: AgentConfig = {
    id: "parent01",
    name: "fix-login",
    projectName: "proj",
    worktreePath: path.join(dir, "worktrees", "fix-login-parent01"),
    branchName: "agent/fix-login-parent01",
    sessionDir: path.join(dir, "sessions", "fix-login-parent01"),
    state: "waiting_input",
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    model: "hawk/claude-opus-5",
    thinkingLevel: "high",
    usage: {
      costUsd: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 0,
    },
  };
  stateManager.putAgent(parent);

  // Register a live handle for the parent so the stop path has something to
  // tear down, and stub session startup for whatever gets created next.
  const sessions = new Map<string, ReturnType<typeof makeFakeSession>>();
  type Handles = Map<string, { config: AgentConfig; session: unknown; unsubscribe: () => void }>;
  const handles = (manager as unknown as { handles: Handles }).handles;
  const register = (config: AgentConfig) => {
    const session = makeFakeSession();
    sessions.set(config.id, session);
    handles.set(config.id, { config, session, unsubscribe: () => {} });
  };
  register(parent);
  (manager as unknown as { startSession: (c: AgentConfig) => Promise<void> }).startSession = async (
    config: AgentConfig,
  ) => {
    register(config);
    (manager as unknown as { setAgentState: (id: string, s: string) => void }).setAgentState(
      config.id,
      "idle",
    );
  };

  const broadcasts: WsEnvelope[] = [];
  manager.onWsBroadcast((e) => broadcasts.push(e));

  return { manager, stateManager, parent, sessions, broadcasts, dir };
}

describe("nextHandoffName", () => {
  it("numbers a series instead of stacking suffixes", () => {
    expect(nextHandoffName("fix-login")).toBe("fix-login-2");
    expect(nextHandoffName("fix-login-2")).toBe("fix-login-3");
    expect(nextHandoffName("fix-login-10")).toBe("fix-login-11");
    expect(nextHandoffName("  ")).toBe("agent-2");
  });
});

describe("AgentManager.handoffAgent", () => {
  it("puts the successor in the parent's worktree, branch and project", async () => {
    const { manager, parent } = await makeManager();

    const successor = await manager.handoffAgent(parent.id, { stopParentDelayMs: 0 });

    expect(successor.id).not.toBe(parent.id);
    expect(successor.name).toBe("fix-login-2");
    expect(successor.worktreePath).toBe(parent.worktreePath);
    expect(successor.branchName).toBe(parent.branchName);
    expect(successor.projectName).toBe(parent.projectName);
    expect(successor.model).toBe(parent.model);
    expect(successor.thinkingLevel).toBe(parent.thinkingLevel);
    expect(successor.parentAgentId).toBe(parent.id);
    // Its own session dir: the point of a handoff is an empty context.
    expect(successor.sessionDir).not.toBe(parent.sessionDir);
  });

  it("archives the parent, broadcasts the change, and stops it", async () => {
    const { manager, stateManager, parent, sessions, broadcasts } = await makeManager();

    await manager.handoffAgent(parent.id, { stopParentDelayMs: 0 });

    expect(stateManager.getAgent(parent.id)?.archived).toBe(true);
    const updates = broadcasts.filter((b) => b.kind === "agent_updated");
    expect(updates).toHaveLength(1);
    expect((updates[0] as { agentId: string }).agentId).toBe(parent.id);

    expect(sessions.get(parent.id)!.calls).toContain("dispose");
    expect(manager.isRunning(parent.id)).toBe(false);
    expect(stateManager.getAgent(parent.id)?.state).toBe("stopped");
  });

  it("defers the parent's teardown so the caller's own tool call survives", async () => {
    vi.useFakeTimers();
    try {
      const { manager, parent, sessions } = await makeManager();

      await manager.handoffAgent(parent.id, { stopParentDelayMs: 5_000 });
      // The agent that asked for the handoff is usually mid-bash-call; it
      // must still be alive when handoffAgent returns.
      expect(manager.isRunning(parent.id)).toBe(true);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(sessions.get(parent.id)!.calls).toContain("dispose");
    } finally {
      vi.useRealTimers();
    }
  });

  it("briefs the successor with the handoff message", async () => {
    const { manager, parent, sessions } = await makeManager();

    const successor = await manager.handoffAgent(parent.id, {
      message: "read HANDOFF.md and continue",
      stopParentDelayMs: 0,
    });
    await new Promise((r) => setImmediate(r));

    expect(sessions.get(successor.id)!.calls).toContain("prompt:read HANDOFF.md and continue");
  });

  it("takes an explicit successor name", async () => {
    const { manager, parent } = await makeManager();
    const successor = await manager.handoffAgent(parent.id, {
      name: "fix-login-take-two",
      stopParentDelayMs: 0,
    });
    expect(successor.name).toBe("fix-login-take-two");
  });

  it("refuses to hand off an unknown agent", async () => {
    const { manager } = await makeManager();
    await expect(manager.handoffAgent("nope", { stopParentDelayMs: 0 })).rejects.toThrow(
      /not found/,
    );
  });

  it("keeps the shared worktree when one of the pair is deleted", async () => {
    const { manager, parent } = await makeManager();
    const successor = await manager.handoffAgent(parent.id, { stopParentDelayMs: 0 });

    // Removing the archived parent with --worktree must not delete the
    // directory the successor is actively working in.
    await manager.removeAgent(parent.id, { deleteWorktree: true });

    expect(manager.getAgent(parent.id)).toBeUndefined();
    expect(manager.getAgent(successor.id)?.worktreePath).toBe(parent.worktreePath);
  });
});
