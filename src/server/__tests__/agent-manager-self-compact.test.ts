/**
 * Tests for `AgentManager.compactAgent` with `afterTurn` — what `pru compact`
 * uses so an agent can compact *itself*. The agent calls it from inside its
 * own tool call, so compacting immediately would abort that call; instead
 * the compaction waits for the turn to end, then (optionally) a continue
 * message wakes the agent back up.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentManager } from "../agent-manager.js";
import { ProjectManager } from "../project-manager.js";
import { StateManager } from "../state.js";
import type { AgentConfig } from "../types.js";

function makeFakeSession(opts: { streaming?: boolean; compactError?: string } = {}) {
  const calls: string[] = [];
  const session = {
    calls,
    isStreaming: opts.streaming ?? false,
    isRetrying: false,
    isCompacting: false,
    messages: [{ role: "user" }],
    async compact(instructions?: string): Promise<void> {
      calls.push(`compact:${instructions ?? ""}:streaming=${session.isStreaming}`);
      if (opts.compactError) throw new Error(opts.compactError);
    },
    dispose(): void {
      calls.push("dispose");
    },
  };
  return session;
}

async function setup(sessionOpts: { streaming?: boolean; compactError?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "pirouette-self-compact-test-"));
  const stateManager = new StateManager(dir);
  const projectManager = new ProjectManager(stateManager, dir);
  const manager = new AgentManager(stateManager, projectManager, dir);
  const config = {
    id: "a1",
    name: "test",
    projectName: "test",
    worktreePath: dir,
    state: "running",
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
  const handles = (manager as unknown as { handles: Map<string, typeof handle> }).handles;
  handles.set("a1", handle);
  const sent: string[] = [];
  vi.spyOn(manager, "sendMessage").mockImplementation(async (_id: string, message: string) => {
    sent.push(message);
  });
  return { manager, session, handles, sent };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AgentManager.compactAgent afterTurn", () => {
  it("compacts an idle agent right away", async () => {
    const { manager, session, sent } = await setup();
    expect(manager.isBusy("a1")).toBe(false);
    await manager.compactAgent("a1", "keep X", { afterTurn: true });
    expect(session.calls).toEqual(["compact:keep X:streaming=false"]);
    expect(sent).toEqual([]);
  });

  it("waits for the current turn to end, then compacts and sends the continue message", async () => {
    vi.useFakeTimers();
    const { manager, session, sent } = await setup({ streaming: true });
    expect(manager.isBusy("a1")).toBe(true);

    const done = manager.compactAgent("a1", undefined, { afterTurn: true, continueMessage: "carry on" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(session.calls).toEqual([]);
    expect(manager.hasPendingCompaction("a1")).toBe(true);
    await expect(
      manager.compactAgent("a1", undefined, { afterTurn: true }),
    ).rejects.toThrow(/already queued/);

    session.isStreaming = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(session.calls).toEqual(["compact::streaming=false"]);
    expect(manager.hasPendingCompaction("a1")).toBe(false);
    expect(sent).toEqual(["carry on"]);
  });

  it("still wakes the agent when the compaction fails, with the error", async () => {
    const { manager, sent } = await setup({ compactError: "Nothing to compact (session too small)" });
    await expect(
      manager.compactAgent("a1", undefined, { afterTurn: true, continueMessage: "carry on" }),
    ).rejects.toThrow(/Nothing to compact/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Nothing to compact");
    expect(sent[0]).toContain("carry on");
  });

  it("drops a queued compaction if the agent is stopped before its turn ends", async () => {
    vi.useFakeTimers();
    const { manager, session, handles, sent } = await setup({ streaming: true });
    const done = manager.compactAgent("a1", undefined, { afterTurn: true, continueMessage: "carry on" });
    await vi.advanceTimersByTimeAsync(1_000);
    handles.delete("a1");
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(session.calls).toEqual([]);
    expect(sent).toEqual([]);
    expect(manager.hasPendingCompaction("a1")).toBe(false);
  });

  it("without afterTurn, compacts a streaming agent immediately (dashboard /compact)", async () => {
    const { manager, session } = await setup({ streaming: true });
    await manager.compactAgent("a1");
    expect(session.calls).toEqual(["compact::streaming=true"]);
  });
});
