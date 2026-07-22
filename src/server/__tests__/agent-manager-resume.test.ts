/**
 * Tests for the shutdown/restart resume cycle.
 *
 * Regression: shutdown() used to stop every running agent via plain
 * stopAgent(), persisting `state: "stopped"` — the same state a *user*
 * stop produces. resumeAll()'s `state === "stopped"` gate then skipped
 * everything after a graceful restart, so no agents came back.
 *
 * The fix: server-initiated stops persist a distinct `"shutdown"` state.
 * resumeAll() still skips user-stopped agents ("stopped") but resumes
 * "shutdown" agents — and anything else ("running", "idle", ... e.g.
 * left behind by a crash).
 *
 * resumeAgent() spins up a real pi session (too heavy for a unit test),
 * so we stub it and ensureResourceLoader(); shutdown()/stopAgent() are
 * exercised for real with a stubbed session handle.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentManager, type AgentHandle } from "../agent-manager.js";
import { ProjectManager } from "../project-manager.js";
import { StateManager } from "../state.js";
import { emptyUsage, type AgentConfig, type AgentState } from "../types.js";

function makeAgent(id: string, state: AgentState): AgentConfig {
  return {
    id,
    name: `agent-${id}`,
    projectName: "scratchpad",
    worktreePath: `/tmp/pirouette-test/${id}`,
    branchName: null,
    sessionDir: `/tmp/pirouette-test/${id}/session`,
    state,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    model: null,
    thinkingLevel: "off",
    usage: emptyUsage(),
    errorMessage: null,
    parentAgentId: null,
  };
}

async function makeManager(agents: AgentConfig[]) {
  const dir = await mkdtemp(path.join(tmpdir(), "pirouette-resume-"));
  const stateManager = new StateManager(dir);
  const projectManager = new ProjectManager(stateManager, dir);
  const manager = new AgentManager(stateManager, projectManager, dir);
  for (const agent of agents) stateManager.putAgent(agent);
  return { manager, stateManager };
}

/** Stub resumeAgent + ensureResourceLoader (both far too heavy for unit
 *  tests: real pi session / extension loading). Returns the list of agent
 *  ids resumeAll() attempted to resume. */
function stubResume(manager: AgentManager): string[] {
  const resumed: string[] = [];
  const m = manager as unknown as {
    ensureResourceLoader(): Promise<unknown>;
    resumeAgent(id: string): Promise<void>;
  };
  m.ensureResourceLoader = async () => ({});
  m.resumeAgent = async (id: string) => {
    resumed.push(id);
  };
  return resumed;
}

/** Register a fake running-session handle so stopAgent()/shutdown() find
 *  something to tear down (the real handle wraps a live pi session). */
function addFakeHandle(manager: AgentManager, config: AgentConfig): void {
  const handle = {
    config,
    session: { abort: async () => {}, dispose: () => {} },
    unsubscribe: () => {},
  } as unknown as AgentHandle;
  (manager as unknown as { handles: Map<string, AgentHandle> }).handles.set(config.id, handle);
}

describe("AgentManager shutdown/restart cycle", () => {
  it("shutdown() persists state 'shutdown', not 'stopped'", async () => {
    const running = makeAgent("a", "running");
    const { manager, stateManager } = await makeManager([running]);
    addFakeHandle(manager, running);
    await manager.shutdown();
    expect(stateManager.getAgent("a")?.state).toBe("shutdown");
  });

  it("stopAgent() without a finalState still persists 'stopped' (user stop)", async () => {
    const running = makeAgent("a", "running");
    const { manager, stateManager } = await makeManager([running]);
    addFakeHandle(manager, running);
    await manager.stopAgent("a");
    expect(stateManager.getAgent("a")?.state).toBe("stopped");
  });

  it("resumeAll() resumes 'shutdown' agents but skips user-'stopped' ones", async () => {
    const { manager } = await makeManager([
      makeAgent("from-shutdown", "shutdown"),
      makeAgent("user-stopped", "stopped"),
    ]);
    const resumed = stubResume(manager);
    await manager.resumeAll();
    expect(resumed).toEqual(["from-shutdown"]);
  });

  it("resumeAll() also resumes agents left in live states (crash case)", async () => {
    const states: AgentState[] = [
      "starting",
      "cloning",
      "running",
      "idle",
      "waiting_input",
      "shutdown",
      "error",
    ];
    const { manager } = await makeManager(states.map((s, i) => makeAgent(`s${i}-${s}`, s)));
    const resumed = stubResume(manager);
    await manager.resumeAll();
    expect(resumed).toHaveLength(states.length);
  });

  it("marks an agent as errored if its resume fails, and keeps going", async () => {
    const { manager, stateManager } = await makeManager([
      makeAgent("bad", "shutdown"),
      makeAgent("good", "shutdown"),
    ]);
    const resumed = stubResume(manager);
    const m = manager as unknown as { resumeAgent(id: string): Promise<void> };
    const original = m.resumeAgent.bind(manager);
    m.resumeAgent = async (id: string) => {
      if (id === "bad") throw new Error("boom");
      return original(id);
    };
    await manager.resumeAll();
    expect(resumed).toEqual(["good"]);
    expect(stateManager.getAgent("bad")?.state).toBe("error");
    expect(stateManager.getAgent("good")?.state).toBe("shutdown");
  });

  it("full cycle: shutdown() then resumeAll() brings the same agents back", async () => {
    const wasRunning = makeAgent("was-running", "waiting_input");
    const userStopped = makeAgent("user-stopped", "running");
    const { manager, stateManager } = await makeManager([wasRunning, userStopped]);
    addFakeHandle(manager, wasRunning);
    addFakeHandle(manager, userStopped);

    // User explicitly stops one agent; then the server goes down.
    await manager.stopAgent("user-stopped");
    await manager.shutdown();
    expect(stateManager.getAgent("was-running")?.state).toBe("shutdown");
    expect(stateManager.getAgent("user-stopped")?.state).toBe("stopped");

    // "Restart": resumeAll on the same persisted state.
    const resumed = stubResume(manager);
    await manager.resumeAll();
    expect(resumed).toEqual(["was-running"]);
  });
});
