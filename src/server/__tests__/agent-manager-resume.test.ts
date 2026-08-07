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
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentManager, type AgentHandle } from "../agent-manager.js";
import { ProjectManager } from "../project-manager.js";
import { StateManager } from "../state.js";
import { writeRestartNotice } from "../restart-notice.js";
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
  return { manager, stateManager, dir };
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

/** Stub autoContinueAfterResume so we can assert *which* agents get nudged
 *  to continue their interrupted turn, without a real pi session. */
function stubAutoContinue(manager: AgentManager): string[] {
  const continued: string[] = [];
  (manager as unknown as { autoContinueAfterResume(id: string): void }).autoContinueAfterResume =
    (id: string) => {
      continued.push(id);
    };
  return continued;
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

  it("shutdown() flags a mid-turn ('running') agent as interruptedTurn", async () => {
    const running = makeAgent("a", "running");
    const waiting = makeAgent("b", "waiting_input");
    const { manager, stateManager } = await makeManager([running, waiting]);
    addFakeHandle(manager, running);
    addFakeHandle(manager, waiting);
    await manager.shutdown();
    expect(stateManager.getAgent("a")?.interruptedTurn).toBe(true);
    expect(stateManager.getAgent("b")?.interruptedTurn).toBe(false);
  });

  it("resumeAll() auto-continues only the interrupted agents", async () => {
    const midTurn = makeAgent("mid", "shutdown");
    midTurn.interruptedTurn = true;
    const finished = makeAgent("done", "shutdown");
    finished.interruptedTurn = false;
    const { manager, stateManager } = await makeManager([midTurn, finished]);
    stubResume(manager);
    const continued = stubAutoContinue(manager);
    await manager.resumeAll();
    expect(continued).toEqual(["mid"]);
    // The flag deliberately survives resumeAll(): it is cleared only once
    // the nudge has actually been delivered (see "post-restart nudges"),
    // so a boot that dies mid-resume retries instead of dropping the work.
    expect(stateManager.getAgent("mid")?.interruptedTurn).toBe(true);
  });

  it("resumeAll() auto-continues an agent left 'running' by a crash", async () => {
    // No interruptedTurn flag (shutdown never ran); the live "running"
    // state is the only signal.
    const crashed = makeAgent("crashed", "running");
    const { manager } = await makeManager([crashed]);
    stubResume(manager);
    const continued = stubAutoContinue(manager);
    await manager.resumeAll();
    expect(continued).toEqual(["crashed"]);
  });

  it("resumeAll() does NOT auto-continue an agent that was waiting for input", async () => {
    const waiting = makeAgent("w", "shutdown");
    waiting.interruptedTurn = false;
    const { manager } = await makeManager([waiting]);
    stubResume(manager);
    const continued = stubAutoContinue(manager);
    await manager.resumeAll();
    expect(continued).toEqual([]);
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

/** A stand-in for a live pi session: records the prompts pirouette pushes
 *  at it and can be told to reject the first N of them (the "provider is
 *  still waking up right after a restart" case). */
interface FakeSession {
  messages: unknown[];
  isStreaming: boolean;
  prompts: string[];
  failuresLeft: number;
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

/** A session whose `prompt()` stays pending until the turn is aborted,
 *  and then *resolves* — which is what pi does: an aborted turn is not a
 *  rejected promise. Models an agent still working when the server is
 *  told to shut down. */
function makeAbortableSession(opts: { onAbort?: () => void } = {}): FakeSession {
  let settle: (() => void) | null = null;
  const session: FakeSession = {
    messages: new Array(3).fill({}),
    isStreaming: false,
    prompts: [],
    failuresLeft: 0,
    prompt(message: string) {
      session.prompts.push(message);
      session.isStreaming = true;
      return new Promise<void>((resolve) => {
        settle = resolve;
      });
    },
    async abort() {
      session.isStreaming = false;
      opts.onAbort?.();
      settle?.();
      settle = null;
    },
    dispose() {},
  };
  return session;
}

function makeFakeSession(opts: { history?: number; failures?: number } = {}): FakeSession {
  const session: FakeSession = {
    messages: new Array(opts.history ?? 3).fill({}),
    isStreaming: false,
    prompts: [],
    failuresLeft: opts.failures ?? 0,
    async prompt(message: string) {
      session.prompts.push(message);
      if (session.failuresLeft > 0) {
        session.failuresLeft -= 1;
        throw new Error("model provider not ready");
      }
    },
    async abort() {},
    dispose() {},
  };
  return session;
}

/** Stub resumeAgent so it installs a fake handle (so the REAL
 *  autoContinueAfterResume path runs), and return the sessions by id. */
function stubResumeWithSessions(
  manager: AgentManager,
  sessions: Map<string, FakeSession>,
): void {
  const m = manager as unknown as {
    ensureResourceLoader(): Promise<unknown>;
    resumeAgent(id: string): Promise<void>;
    handles: Map<string, AgentHandle>;
    stateManager: StateManager;
  };
  m.ensureResourceLoader = async () => ({});
  m.resumeAgent = async (id: string) => {
    const config = m.stateManager.getAgent(id);
    if (!config) throw new Error(`no agent ${id}`);
    const session = sessions.get(id) ?? makeFakeSession();
    sessions.set(id, session);
    m.handles.set(id, {
      config,
      session,
      unsubscribe: () => {},
    } as unknown as AgentHandle);
  };
}

describe("post-restart nudges", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wakes the agent that ran `pru self-update`, even though its turn had ended", async () => {
    // The initiating agent is NOT mid-turn: it printed "update kicked off"
    // and finished long before the installer restarted the service.
    const initiator = makeAgent("initiator", "shutdown");
    initiator.interruptedTurn = false;
    const bystander = makeAgent("bystander", "shutdown");
    bystander.interruptedTurn = false;
    const { manager, dir } = await makeManager([initiator, bystander]);
    writeRestartNotice(dir, {
      requestedAt: new Date().toISOString(),
      sessionDir: initiator.sessionDir,
      plan: "npm install pkg@latest",
    });

    const sessions = new Map<string, FakeSession>();
    stubResumeWithSessions(manager, sessions);
    await manager.resumeAll();
    // Nudge delivery is fire-and-forget; let the microtasks drain.
    await new Promise((r) => setTimeout(r, 0));

    expect(sessions.get("initiator")?.prompts).toHaveLength(1);
    expect(sessions.get("initiator")?.prompts[0]).toContain("self-update");
    expect(sessions.get("initiator")?.prompts[0]).toContain("npm install pkg@latest");
    expect(sessions.get("bystander")?.prompts).toEqual([]);
  });

  it("consumes the notice so a later restart doesn't re-nudge", async () => {
    const initiator = makeAgent("initiator", "shutdown");
    initiator.interruptedTurn = false;
    const { manager, stateManager, dir } = await makeManager([initiator]);
    writeRestartNotice(dir, {
      requestedAt: new Date().toISOString(),
      sessionDir: initiator.sessionDir,
    });
    const sessions = new Map<string, FakeSession>();
    stubResumeWithSessions(manager, sessions);

    await manager.resumeAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(sessions.get("initiator")?.prompts).toHaveLength(1);

    // Second boot: no notice on disk any more. (The agent is parked at
    // waiting_input, as a real agent_end event would leave it.)
    (manager as unknown as { handles: Map<string, AgentHandle> }).handles.clear();
    stateManager.updateAgentState("initiator", { state: "waiting_input" });
    await manager.resumeAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(sessions.get("initiator")?.prompts).toHaveLength(1);
  });

  it("nudges an interrupted agent exactly once, not twice, when it also started the update", async () => {
    const agent = makeAgent("both", "shutdown");
    agent.interruptedTurn = true;
    const { manager, dir } = await makeManager([agent]);
    writeRestartNotice(dir, {
      requestedAt: new Date().toISOString(),
      sessionDir: agent.sessionDir,
    });
    const sessions = new Map<string, FakeSession>();
    stubResumeWithSessions(manager, sessions);

    await manager.resumeAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(sessions.get("both")?.prompts).toHaveLength(1);
  });

  it("clears interruptedTurn only after the nudge is delivered", async () => {
    const agent = makeAgent("mid", "shutdown");
    agent.interruptedTurn = true;
    const { manager, stateManager } = await makeManager([agent]);
    const sessions = new Map<string, FakeSession>();
    stubResumeWithSessions(manager, sessions);

    await manager.resumeAll();
    // resumeAll must NOT have cleared the flag optimistically...
    await new Promise((r) => setTimeout(r, 0));
    // ...but once the turn lands, it's cleared so the next boot is quiet.
    expect(stateManager.getAgent("mid")?.interruptedTurn).toBe(false);
    expect(sessions.get("mid")?.prompts).toHaveLength(1);
  });

  it("retries a nudge the provider rejects, and keeps the flag until it lands", async () => {
    vi.useFakeTimers();
    const agent = makeAgent("flaky", "shutdown");
    agent.interruptedTurn = true;
    const { manager, stateManager } = await makeManager([agent]);
    const sessions = new Map<string, FakeSession>([
      ["flaky", makeFakeSession({ failures: 1 })],
    ]);
    stubResumeWithSessions(manager, sessions);

    await manager.resumeAll();
    await vi.advanceTimersByTimeAsync(0);
    // First attempt was rejected: still flagged, agent not abandoned.
    expect(sessions.get("flaky")?.prompts).toHaveLength(1);
    expect(stateManager.getAgent("flaky")?.interruptedTurn).toBe(true);

    // The retry (after the backoff) succeeds.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sessions.get("flaky")?.prompts).toHaveLength(2);
    expect(stateManager.getAgent("flaky")?.interruptedTurn).toBe(false);
  });

  it("leaves an agent usable (and re-nudgeable) if every attempt fails", async () => {
    vi.useFakeTimers();
    const agent = makeAgent("dead-provider", "shutdown");
    agent.interruptedTurn = true;
    const { manager, stateManager } = await makeManager([agent]);
    const sessions = new Map<string, FakeSession>([
      ["dead-provider", makeFakeSession({ failures: 99 })],
    ]);
    stubResumeWithSessions(manager, sessions);

    await manager.resumeAll();
    await vi.advanceTimersByTimeAsync(120_000);

    const cfg = stateManager.getAgent("dead-provider");
    // Not wedged in "error": the user can still talk to it.
    expect(cfg?.state).toBe("waiting_input");
    expect(cfg?.errorMessage).toMatch(/auto-continue/);
    // Flag survives so the NEXT boot tries again.
    expect(cfg?.interruptedTurn).toBe(true);
  });

  it("does not nudge an agent whose session vanished (user stopped it)", async () => {
    vi.useFakeTimers();
    const agent = makeAgent("gone", "shutdown");
    agent.interruptedTurn = true;
    const { manager } = await makeManager([agent]);
    const sessions = new Map<string, FakeSession>();
    stubResumeWithSessions(manager, sessions);
    const m = manager as unknown as { handles: Map<string, AgentHandle> };
    // Resume installs a handle; drop it before the nudge is dispatched.
    const original = (manager as unknown as { resumeAgent(id: string): Promise<void> }).resumeAgent;
    (manager as unknown as { resumeAgent(id: string): Promise<void> }).resumeAgent = async (
      id: string,
    ) => {
      await original.call(manager, id);
      m.handles.delete(id);
    };

    await manager.resumeAll();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sessions.get("gone")?.prompts).toEqual([]);
  });

  it("retries a failed resume in the background instead of parking the agent", async () => {
    vi.useFakeTimers();
    const agent = makeAgent("late", "shutdown");
    agent.interruptedTurn = true;
    const { manager, stateManager } = await makeManager([agent]);
    const sessions = new Map<string, FakeSession>();
    stubResumeWithSessions(manager, sessions);

    // First resume attempt blows up (auth still refreshing), later ones work.
    const m = manager as unknown as { resumeAgent(id: string): Promise<void> };
    const working = m.resumeAgent.bind(manager);
    let calls = 0;
    m.resumeAgent = async (id: string) => {
      calls += 1;
      if (calls === 1) throw new Error("token refresh failed");
      return working(id);
    };

    await manager.resumeAll();
    expect(stateManager.getAgent("late")?.state).toBe("error");

    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBe(2);
    expect(sessions.get("late")?.prompts).toHaveLength(1);
    expect(stateManager.getAgent("late")?.errorMessage).toBeNull();
  });
});

/**
 * Regression: an agent auto-continued by one restart was silently
 * orphaned by the next one.
 *
 * `deliverResumeNudge` clears `interruptedTurn` when its `prompt()`
 * settles. But pi *resolves* an in-flight prompt when the turn is
 * aborted, and `shutdown()` aborts every live session — so a nudge turn
 * the shutdown just killed looked exactly like one that ran to
 * completion. The flag was cleared after `shutdown()` had already
 * snapshotted the correct value, and the next boot resumed the session
 * without nudging it: the agent came back with a transcript ending in an
 * aborted command, parked at `waiting_input` with nobody to restart it.
 *
 * Only agents still working on the *previous* restart's nudge could hit
 * this, which is why it took back-to-back restarts to show up.
 */
describe("shutdown while a post-restart nudge is still in flight", () => {
  it("keeps interruptedTurn set when the shutdown aborts the nudge turn", async () => {
    const agent = makeAgent("mid", "shutdown");
    agent.interruptedTurn = true;
    const { manager, stateManager } = await makeManager([agent]);
    const session = makeAbortableSession();
    stubResumeWithSessions(manager, new Map([["mid", session]]));

    await manager.resumeAll();
    await new Promise((r) => setTimeout(r, 0));
    // The nudge went out and is still running.
    expect(session.prompts).toHaveLength(1);
    expect(stateManager.getAgent("mid")?.interruptedTurn).toBe(true);

    await manager.shutdown();
    await new Promise((r) => setTimeout(r, 0));

    expect(stateManager.getAgent("mid")?.state).toBe("shutdown");
    expect(stateManager.getAgent("mid")?.interruptedTurn).toBe(true);
  });

  it("survives teardown side effects that write agent state", async () => {
    // Aborting a real session emits `agent_end`, which the event handler
    // turns into `waiting_input` — a write that lands *after* shutdown()
    // recorded its snapshot.
    const agent = makeAgent("mid", "shutdown");
    agent.interruptedTurn = true;
    const { manager, stateManager } = await makeManager([agent]);
    const session = makeAbortableSession({
      onAbort: () => {
        stateManager.updateAgentState("mid", { state: "waiting_input" });
      },
    });
    stubResumeWithSessions(manager, new Map([["mid", session]]));

    await manager.resumeAll();
    await new Promise((r) => setTimeout(r, 0));
    await manager.shutdown();
    await new Promise((r) => setTimeout(r, 0));

    expect(stateManager.getAgent("mid")?.state).toBe("shutdown");
    expect(stateManager.getAgent("mid")?.interruptedTurn).toBe(true);
  });

  it("the next boot nudges the agent again, reading state back off disk", async () => {
    const agent = makeAgent("mid", "shutdown");
    agent.interruptedTurn = true;
    const { manager, dir } = await makeManager([agent]);
    stubResumeWithSessions(manager, new Map([["mid", makeAbortableSession()]]));

    await manager.resumeAll();
    await new Promise((r) => setTimeout(r, 0));
    await manager.shutdown();
    await new Promise((r) => setTimeout(r, 0));

    // A brand-new process over the same data dir.
    const nextState = new StateManager(dir);
    await nextState.load();
    const nextManager = new AgentManager(nextState, new ProjectManager(nextState, dir), dir);
    const nextSessions = new Map<string, FakeSession>();
    stubResumeWithSessions(nextManager, nextSessions);

    await nextManager.resumeAll();
    await new Promise((r) => setTimeout(r, 0));

    expect(nextSessions.get("mid")?.prompts).toHaveLength(1);
    expect(nextState.getAgent("mid")?.interruptedTurn).toBe(false);
  });

  it("preserves an undelivered nudge across a shutdown of an idle agent", async () => {
    // Every nudge attempt failed last boot, so the agent is parked at
    // waiting_input with the flag kept for a retry. A shutdown must not
    // read "not running" and throw that retry away.
    const agent = makeAgent("pending", "waiting_input");
    agent.interruptedTurn = true;
    const { manager, stateManager } = await makeManager([agent]);
    addFakeHandle(manager, agent);

    await manager.shutdown();

    expect(stateManager.getAgent("pending")?.interruptedTurn).toBe(true);
  });
});
