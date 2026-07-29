/**
 * Sending a message to an archived chat un-archives it.
 *
 * Archiving means "tuck this away, I'm done with it". Typing into the chat
 * contradicts that: if the flag stuck, the chat would stay hidden behind the
 * dashboard's "show archived" toggle and the agent's reply would look lost.
 *
 * These tests drive `AgentManager.sendMessage` against a fake pi session and
 * assert the persisted `archived` flag flips to false and an `agent_updated`
 * envelope goes out to WS clients — the same envelope the /archive endpoint
 * broadcasts, so the browser's existing merge path handles it.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentManager } from "../agent-manager.js";
import { ProjectManager } from "../project-manager.js";
import { StateManager } from "../state.js";
import type { AgentConfig, WsEnvelope } from "../types.js";

/** Minimal stand-in for pi's AgentSession: just enough surface for
 *  sendMessage's idle (`prompt`) and streaming (`steer`) branches. */
function makeFakeSession() {
  let isStreaming = false;
  let resolvePrompt: (() => void) | null = null;
  const steerCalls: string[] = [];

  return {
    get isStreaming() {
      return isStreaming;
    },
    steerCalls,
    finishPrompt(): void {
      const r = resolvePrompt;
      resolvePrompt = null;
      isStreaming = false;
      r?.();
    },
    prompt(): Promise<void> {
      isStreaming = true;
      return new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
    },
    async steer(text: string): Promise<void> {
      steerCalls.push(text);
    },
    async followUp(text: string): Promise<void> {
      steerCalls.push(text);
    },
  };
}

async function makeManagerWithFakeAgent(agentId: string, archived: boolean) {
  const dir = await mkdtemp(path.join(tmpdir(), "pirouette-unarchive-test-"));
  const stateManager = new StateManager(dir);
  const projectManager = new ProjectManager(stateManager, dir);
  const manager = new AgentManager(stateManager, projectManager, dir);

  const config = {
    id: agentId,
    name: "test",
    projectName: "test",
    worktreePath: dir,
    state: "waiting_input" as const,
    createdAt: Date.now(),
    sessionDir: dir,
    archived,
  } as unknown as AgentConfig;
  stateManager.putAgent(config);

  const session = makeFakeSession();
  const handle = {
    config,
    session: session as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
    unsubscribe: () => {},
  };
  (manager as unknown as { handles: Map<string, typeof handle> }).handles.set(agentId, handle);

  const broadcasts: WsEnvelope[] = [];
  manager.onWsBroadcast((envelope) => broadcasts.push(envelope));

  return { manager, session, stateManager, broadcasts, config };
}

describe("AgentManager.sendMessage un-archives the chat", () => {
  it("clears the archived flag on an idle archived agent and broadcasts agent_updated", async () => {
    const { manager, session, stateManager, broadcasts } = await makeManagerWithFakeAgent(
      "agent-archived",
      true,
    );
    expect(stateManager.getAgent("agent-archived")?.archived).toBe(true);

    const send = manager.sendMessage("agent-archived", "still working on this");
    await new Promise((r) => setImmediate(r));

    expect(stateManager.getAgent("agent-archived")?.archived).toBe(false);

    const updates = broadcasts.filter((b) => b.kind === "agent_updated");
    expect(updates).toHaveLength(1);
    const update = updates[0] as Extract<WsEnvelope, { kind: "agent_updated" }>;
    expect(update.agentId).toBe("agent-archived");
    expect(update.agent.archived).toBe(false);
    // The envelope carries the live-ness flag the sidebar renders from.
    expect(update.agent.running).toBe(true);

    session.finishPrompt();
    await send;
  });

  it("un-archives on a mid-turn steer too, not just a fresh turn", async () => {
    const { manager, session, stateManager, broadcasts } = await makeManagerWithFakeAgent(
      "agent-steer",
      false,
    );

    // Start a turn, then archive mid-flight (the user tidying the sidebar
    // while the agent works), then steer into it.
    const firstSend = manager.sendMessage("agent-steer", "go");
    await new Promise((r) => setImmediate(r));
    expect(session.isStreaming).toBe(true);

    manager.setArchived("agent-steer", true);
    expect(stateManager.getAgent("agent-steer")?.archived).toBe(true);

    await manager.sendMessage("agent-steer", "actually, do it this way");
    expect(session.steerCalls).toEqual(["actually, do it this way"]);
    expect(stateManager.getAgent("agent-steer")?.archived).toBe(false);
    expect(broadcasts.filter((b) => b.kind === "agent_updated")).toHaveLength(1);

    session.finishPrompt();
    await firstSend;
  });

  it("is a no-op (no broadcast) when the chat was never archived", async () => {
    const { manager, session, stateManager, broadcasts } = await makeManagerWithFakeAgent(
      "agent-plain",
      false,
    );

    const send = manager.sendMessage("agent-plain", "hello");
    await new Promise((r) => setImmediate(r));

    expect(stateManager.getAgent("agent-plain")?.archived).toBe(false);
    expect(broadcasts.filter((b) => b.kind === "agent_updated")).toHaveLength(0);

    session.finishPrompt();
    await send;
  });
});
