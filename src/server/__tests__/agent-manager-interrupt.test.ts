/**
 * Tests for `AgentManager.interruptAgent` — the dashboard's Escape key.
 *
 * Interrupt is deliberately NOT `stopAgent`: the pi session must survive so
 * the next message continues the same conversation. What it does do is
 * cancel whatever is in flight (turn / compaction / session-level bash),
 * drop the steering + follow-up queue (so an abort doesn't immediately
 * re-trigger a queued turn), and hand the dropped messages back to the
 * caller so the UI can restore them into the composer — same as pi's TUI.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentManager } from "../agent-manager.js";
import { ProjectManager } from "../project-manager.js";
import { StateManager } from "../state.js";
import type { AgentConfig, AgentState } from "../types.js";

interface FakeSessionOptions {
  streaming?: boolean;
  compacting?: boolean;
  bashRunning?: boolean;
  retrying?: boolean;
  /** When true, `abort()` never resolves (simulates a wedged tool teardown). */
  abortHangs?: boolean;
  queue?: { steering: string[]; followUp: string[] };
  messageCount?: number;
}

function makeFakeSession(opts: FakeSessionOptions = {}) {
  let streaming = opts.streaming ?? false;
  const queue = {
    steering: [...(opts.queue?.steering ?? [])],
    followUp: [...(opts.queue?.followUp ?? [])],
  };
  const calls: string[] = [];

  return {
    calls,
    get isStreaming() {
      return streaming;
    },
    get isRetrying() {
      return opts.retrying ?? false;
    },
    get isCompacting() {
      return opts.compacting ?? false;
    },
    get isBashRunning() {
      return opts.bashRunning ?? false;
    },
    messages: Array.from({ length: opts.messageCount ?? 2 }, () => ({ role: "user" })),
    clearQueue() {
      calls.push("clearQueue");
      const snapshot = { steering: [...queue.steering], followUp: [...queue.followUp] };
      queue.steering = [];
      queue.followUp = [];
      return snapshot;
    },
    async abort(): Promise<void> {
      calls.push("abort");
      if (opts.abortHangs) return new Promise<void>(() => {});
      streaming = false;
    },
    abortCompaction(): void {
      calls.push("abortCompaction");
    },
    abortBash(): void {
      calls.push("abortBash");
    },
    dispose(): void {
      calls.push("dispose");
    },
  };
}

async function makeManagerWithFakeAgent(
  agentId: string,
  sessionOpts: FakeSessionOptions = {},
  state: AgentState = "running",
) {
  const dir = await mkdtemp(path.join(tmpdir(), "pirouette-interrupt-test-"));
  const stateManager = new StateManager(dir);
  const projectManager = new ProjectManager(stateManager, dir);
  const manager = new AgentManager(stateManager, projectManager, dir);

  const config = {
    id: agentId,
    name: "test",
    projectName: "test",
    worktreePath: dir,
    state,
    createdAt: new Date().toISOString(),
    sessionDir: dir,
  } as unknown as AgentConfig;
  stateManager.putAgent(config);

  const session = makeFakeSession(sessionOpts);
  const handle = {
    config,
    session: session as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
    unsubscribe: () => {},
  };
  (manager as unknown as { handles: Map<string, typeof handle> }).handles.set(agentId, handle);

  return { manager, session, stateManager };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentManager.interruptAgent", () => {
  it("aborts a streaming turn and returns the queued messages it dropped", async () => {
    const { manager, session, stateManager } = await makeManagerWithFakeAgent("a1", {
      streaming: true,
      queue: { steering: ["also check the tests"], followUp: ["then push"] },
    });

    const result = await manager.interruptAgent("a1");

    expect(result.interrupted).toBe(true);
    expect(result.cancelled).toEqual(["turn"]);
    expect(result.settled).toBe(true);
    expect(result.cleared).toEqual({
      steering: ["also check the tests"],
      followUp: ["then push"],
    });
    // Queue is dropped BEFORE the abort so pi can't flush it into a new turn.
    expect(session.calls).toEqual(["clearQueue", "abort"]);
    // The session stays alive — interrupt is not stop.
    expect(manager.isRunning("a1")).toBe(true);
    expect(session.calls).not.toContain("dispose");
    // Our fake never emits agent_end, so this also covers the state-machine
    // backstop: a no-longer-streaming agent must not be left as "running".
    expect(stateManager.getAgent("a1")?.state).toBe("waiting_input");
  });

  it("is a no-op report when nothing is in flight", async () => {
    const { manager, session } = await makeManagerWithFakeAgent(
      "a2",
      { streaming: false },
      "waiting_input",
    );

    const result = await manager.interruptAgent("a2");

    expect(result.interrupted).toBe(false);
    expect(result.cancelled).toEqual([]);
    expect(result.cleared).toEqual({ steering: [], followUp: [] });
    expect(session.calls).toEqual([]);
  });

  it("cancels an in-flight compaction", async () => {
    const { manager, session } = await makeManagerWithFakeAgent("a3", { compacting: true });

    const result = await manager.interruptAgent("a3");

    expect(result.cancelled).toEqual(["compaction"]);
    expect(session.calls).toEqual(["abortCompaction"]);
  });

  it("cancels a session-level bash run when no turn is streaming", async () => {
    const { manager, session } = await makeManagerWithFakeAgent("a4", { bashRunning: true });

    const result = await manager.interruptAgent("a4");

    expect(result.cancelled).toEqual(["bash"]);
    expect(session.calls).toEqual(["abortBash"]);
  });

  it("treats an auto-retry backoff as an interruptible turn", async () => {
    const { manager, session } = await makeManagerWithFakeAgent("a5", {
      streaming: false,
      retrying: true,
    });

    const result = await manager.interruptAgent("a5");

    expect(result.cancelled).toEqual(["turn"]);
    expect(session.calls).toEqual(["clearQueue", "abort"]);
  });

  it("doesn't hang forever when abort() never reaches idle", async () => {
    vi.useFakeTimers();
    const { manager, session, stateManager } = await makeManagerWithFakeAgent("a6", {
      streaming: true,
      abortHangs: true,
    });

    const pending = manager.interruptAgent("a6");
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await pending;

    expect(result.interrupted).toBe(true);
    expect(result.settled).toBe(false);
    expect(session.calls).toContain("abort");
    // We stopped waiting, but the turn is still (as far as we know) live —
    // don't lie about the state machine.
    expect(stateManager.getAgent("a6")?.state).toBe("running");
  });

  it("throws when the agent isn't running", async () => {
    const { manager } = await makeManagerWithFakeAgent("a7");
    (manager as unknown as { handles: Map<string, unknown> }).handles.delete("a7");

    await expect(manager.interruptAgent("a7")).rejects.toThrow(/not running/);
  });
});
