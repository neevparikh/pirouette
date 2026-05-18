/**
 * Regression test for the "steering behaves like follow-up" bug.
 *
 * Before the fix, `AgentManager.sendMessage` held the per-agent lock for the
 * entire duration of `session.prompt()` -- which doesn't resolve until pi's
 * agent loop emits `agent_end`. Any sendMessage call landing mid-turn (i.e.
 * the user trying to steer) would block on the lock until the current turn
 * finished, at which point `isStreaming` had flipped to false and the message
 * was dispatched via `prompt()` (a new turn) instead of `steer()`.
 *
 * Fix: only hold the lock for the brief critical section that decides which
 * pi API to invoke. The long-lived `prompt()` promise is awaited outside the
 * lock so subsequent steer/followUp sendMessage calls can race in.
 *
 * This test installs a fake `AgentSession` and asserts that:
 *   - the first sendMessage on an idle agent dispatches via `prompt()`;
 *   - a second sendMessage landing while prompt() is still in flight
 *     (isStreaming=true) dispatches via `steer()` and resolves promptly
 *     without waiting for the first prompt to finish.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentManager } from "../agent-manager.js";
import { ProjectManager } from "../project-manager.js";
import { StateManager } from "../state.js";
import type { AgentConfig } from "../types.js";

function makeFakeSession() {
  let isStreaming = false;
  const promptCalls: Array<{ text: string; opts?: unknown }> = [];
  const steerCalls: Array<{ text: string; images?: unknown }> = [];
  const followUpCalls: Array<{ text: string; images?: unknown }> = [];

  /** Resolver for the in-flight prompt promise. Tests call this to simulate
   *  pi finishing the agent loop. */
  let resolvePrompt: (() => void) | null = null;

  return {
    get isStreaming() {
      return isStreaming;
    },
    promptCalls,
    steerCalls,
    followUpCalls,
    finishPrompt(): void {
      const r = resolvePrompt;
      resolvePrompt = null;
      isStreaming = false;
      r?.();
    },
    // Methods sendMessage uses:
    prompt(text: string, opts?: unknown): Promise<void> {
      promptCalls.push({ text, opts });
      isStreaming = true;
      return new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
    },
    async steer(text: string, images?: unknown): Promise<void> {
      steerCalls.push({ text, images });
      // Real pi steer() returns quickly after enqueueing.
    },
    async followUp(text: string, images?: unknown): Promise<void> {
      followUpCalls.push({ text, images });
    },
  };
}

async function makeManagerWithFakeAgent(agentId: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "pirouette-test-"));
  const stateManager = new StateManager(dir);
  const projectManager = new ProjectManager(stateManager, dir);
  const manager = new AgentManager(stateManager, projectManager, dir);

  const config = {
    id: agentId,
    name: "test",
    projectName: "test",
    worktreePath: dir,
    state: "running" as const,
    createdAt: Date.now(),
    sessionDir: dir,
  } as unknown as AgentConfig;
  stateManager.putAgent(config);

  const session = makeFakeSession();
  const handle = {
    config,
    session: session as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
    unsubscribe: () => {},
  };
  // Reach into the private handles map. Type-cast escape hatch is fine for
  // a focused unit test.
  (manager as unknown as { handles: Map<string, typeof handle> }).handles.set(
    agentId,
    handle,
  );

  return { manager, session };
}

/** Race a promise with a timeout. Returns "resolved" / "rejected" / "timeout". */
async function settle<T>(p: Promise<T>, ms: number): Promise<"resolved" | "rejected" | "timeout"> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), ms);
  });
  try {
    return await Promise.race([
      p.then(() => "resolved" as const, () => "rejected" as const),
      timeout,
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

describe("AgentManager.sendMessage steer-during-prompt race", () => {
  it("a mid-turn sendMessage dispatches via steer() and doesn't block on the in-flight prompt()", async () => {
    const { manager, session } = await makeManagerWithFakeAgent("agent-1");

    // 1. Idle agent: kick off prompt(). Don't await -- it won't resolve until
    //    we call session.finishPrompt() (simulating pi's agent_end).
    const firstSend = manager.sendMessage("agent-1", "msg1", { mode: "steer" });

    // Yield to let the first sendMessage acquire the lock + dispatch.
    await new Promise((r) => setImmediate(r));
    expect(session.promptCalls).toHaveLength(1);
    expect(session.promptCalls[0].text).toBe("msg1");
    expect(session.isStreaming).toBe(true);

    // 2. While prompt() is still pending, send a steer message.
    const secondSend = manager.sendMessage("agent-1", "msg2-steer", { mode: "steer" });

    // The second call MUST resolve without us finishing the first prompt --
    // that's the whole point of the fix.
    const result = await settle(secondSend, 200);
    expect(result).toBe("resolved");

    // It went through steer(), not prompt().
    expect(session.steerCalls).toHaveLength(1);
    expect(session.steerCalls[0].text).toBe("msg2-steer");
    expect(session.promptCalls).toHaveLength(1); // unchanged

    // 3. Now finish the first prompt; the firstSend promise should resolve.
    session.finishPrompt();
    await firstSend;
  });

  it("a mid-turn followUp dispatches via followUp() and doesn't block", async () => {
    const { manager, session } = await makeManagerWithFakeAgent("agent-2");

    const firstSend = manager.sendMessage("agent-2", "msg1", { mode: "steer" });
    await new Promise((r) => setImmediate(r));
    expect(session.isStreaming).toBe(true);

    const secondSend = manager.sendMessage("agent-2", "msg2-followup", { mode: "followUp" });
    const result = await settle(secondSend, 200);
    expect(result).toBe("resolved");
    expect(session.followUpCalls).toHaveLength(1);
    expect(session.followUpCalls[0].text).toBe("msg2-followup");
    expect(session.steerCalls).toHaveLength(0);

    session.finishPrompt();
    await firstSend;
  });

  it("sendMessage on an idle agent dispatches via prompt()", async () => {
    const { manager, session } = await makeManagerWithFakeAgent("agent-3");

    const send = manager.sendMessage("agent-3", "msg1", { mode: "steer" });
    // Should reach the prompt() call point quickly.
    await new Promise((r) => setImmediate(r));
    expect(session.promptCalls).toHaveLength(1);
    expect(session.steerCalls).toHaveLength(0);

    // sendMessage shouldn't resolve until prompt() does (we still wait for
    // the long-lived promise outside the lock, just not while holding it).
    const pendingResult = await settle(send, 50);
    expect(pendingResult).toBe("timeout");

    session.finishPrompt();
    await send; // now resolves
  });
});
