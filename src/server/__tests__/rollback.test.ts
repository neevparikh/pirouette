/**
 * Rolling a chat back to before a refused turn: picking the target
 * (rollback.ts) and moving the session there (AgentManager.rollbackAgent).
 */
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";

import { AgentManager } from "../agent-manager.js";
import { AGENT_MESSAGE_TYPE, WATCH_MESSAGE_TYPE } from "../agent-message.js";
import { ProjectManager } from "../project-manager.js";
import { ROLLBACK_ENTRY_TYPE, findRollbackTarget, isBlockedResponse, type RollbackEntry } from "../rollback.js";
import { StateManager } from "../state.js";
import type { AgentConfig } from "../types.js";

const REFUSAL =
  "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.";

describe("isBlockedResponse", () => {
  it.each([
    [{ stopReason: "error", rawStopReason: "refusal", errorMessage: "anything" }, true],
    [{ stopReason: "error", errorMessage: REFUSAL }, true],
    [{ stopReason: "error", errorMessage: "The model refused to complete the request" }, true],
    [{ stopReason: "error", errorMessage: "Provider finish_reason: content_filter" }, true],
    [{ stopReason: "error", errorMessage: "529 overloaded_error" }, false],
    [{ stopReason: "error" }, false],
    [{ stopReason: "stop", rawStopReason: "end_turn" }, false],
  ])("%j -> %s", (message, expected) => {
    expect(isBlockedResponse(message)).toBe(expected);
  });
});

function msg(id: string, role: string, timestamp: number): RollbackEntry {
  return { id, type: "message", message: { role, timestamp } };
}

describe("findRollbackTarget", () => {
  const branch: RollbackEntry[] = [
    msg("u1", "user", 10),
    msg("a1", "assistant", 11),
    msg("u2", "user", 20),
    msg("a2", "assistant", 21),
    msg("t2", "toolResult", 22),
    msg("a2b", "assistant", 23), // refused
    msg("u3", "user", 30),
    msg("a3", "assistant", 31), // refused again
  ];

  it("defaults to the last user message", () => {
    expect(findRollbackTarget(branch)).toEqual({ entryId: "u3", kind: "user", dropped: 2 });
  });

  it("finds the message that started the turn a given reply belongs to", () => {
    expect(findRollbackTarget(branch, 23)).toEqual({ entryId: "u2", kind: "user", dropped: 6 });
  });

  it("targets a user message given its own timestamp", () => {
    expect(findRollbackTarget(branch, 20)?.entryId).toBe("u2");
  });

  it("returns null for a timestamp that isn't on the branch", () => {
    expect(findRollbackTarget(branch, 999)).toBeNull();
  });

  it("returns null when there is no message to roll back to", () => {
    expect(findRollbackTarget([])).toBeNull();
    expect(findRollbackTarget([msg("a", "assistant", 1)])).toBeNull();
  });

  it("treats agent and watch messages as turn starts, but not other custom entries", () => {
    const at = (ms: number) => new Date(ms).toISOString();
    const withCustom: RollbackEntry[] = [
      msg("u1", "user", 10),
      { id: "c1", type: "custom_message", customType: AGENT_MESSAGE_TYPE, timestamp: at(5000) },
      msg("a1", "assistant", 5100),
      { id: "c2", type: "custom_message", customType: WATCH_MESSAGE_TYPE, timestamp: at(9000) },
      { id: "c3", type: "custom_message", customType: "some-extension", timestamp: at(9500) },
      { id: "c4", type: "custom", customType: ROLLBACK_ENTRY_TYPE, timestamp: at(9600) },
    ];
    expect(findRollbackTarget(withCustom)).toEqual({ entryId: "c2", kind: "watch", dropped: 3 });
    // A live session stamps a custom message slightly before its entry.
    expect(findRollbackTarget(withCustom, 4990)).toEqual({ entryId: "c1", kind: "agent", dropped: 5 });
  });
});

// --- AgentManager.rollbackAgent ------------------------------------

function user(text: string, timestamp: number) {
  return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp };
}

function assistant(text: string, timestamp: number, extra: Record<string, unknown> = {}) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
    ...extra,
  };
}

/** A real on-disk SessionManager behind a session whose `navigateTree` does
 *  what pi's does for a user message without summarizing. */
async function makeAgent(opts: { streaming?: boolean; cancel?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "pirouette-rollback-test-"));
  const stateManager = new StateManager(dir);
  const manager = new AgentManager(stateManager, new ProjectManager(stateManager, dir), dir);
  const config = {
    id: "a1",
    name: "test",
    projectName: "test",
    worktreePath: dir,
    state: "waiting_input",
    createdAt: new Date().toISOString(),
    sessionDir: dir,
  } as unknown as AgentConfig;
  stateManager.putAgent(config);

  const sm = SessionManager.create(dir, dir);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const append = (m: unknown) => sm.appendMessage(m as any);
  append(user("first question", 10));
  append(assistant("first answer", 11));
  append(user("look into the exploit", 20));
  append(assistant("", 21, { stopReason: "error", rawStopReason: "refusal", errorMessage: REFUSAL }));

  const session = {
    sessionManager: sm,
    isStreaming: opts.streaming ?? false,
    get messages() {
      return sm.buildSessionContext().messages;
    },
    async navigateTree(targetId: string) {
      if (opts.cancel) return { cancelled: true };
      const entry = sm.getEntry(targetId) as {
        parentId: string | null;
        message: { content: Array<{ text: string }> };
      };
      if (entry.parentId === null) sm.resetLeaf();
      else sm.branch(entry.parentId);
      return { cancelled: false, editorText: entry.message.content[0]!.text };
    },
  };
  const handle = { config, session: session as unknown as AgentSession, unsubscribe: () => {} };
  (manager as unknown as { handles: Map<string, typeof handle> }).handles.set("a1", handle);
  return { manager, sm, dir };
}

describe("AgentManager.rollbackAgent", () => {
  it("flags a refused turn in the transcript", async () => {
    const { manager } = await makeAgent();
    const rows = manager.getMessages("a1");
    expect(rows.at(-1)).toMatchObject({ role: "system", ts: 21, blocked: true });
  });

  it("drops the refused turn and hands back the message that started it", async () => {
    const { manager } = await makeAgent();

    const result = await manager.rollbackAgent("a1", { beforeTs: 21 });

    expect(result).toEqual({ text: "look into the exploit", kind: "user", dropped: 2 });
    expect(manager.getMessages("a1").map((m) => m.content)).toEqual(["first question", "first answer"]);
  });

  it("survives a reload of the session file", async () => {
    const { manager, sm } = await makeAgent();
    await manager.rollbackAgent("a1");

    const reloaded = SessionManager.open(sm.getSessionFile()!);
    const roles = reloaded.buildSessionContext().messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant"]);
    // The refused turn is still in the file, just not on the branch.
    expect(reloaded.getEntries().length).toBeGreaterThan(reloaded.getBranch().length);
  });

  it("can roll back again, down to an empty chat", async () => {
    const { manager } = await makeAgent();
    await manager.rollbackAgent("a1");
    const result = await manager.rollbackAgent("a1");
    expect(result.text).toBe("first question");
    expect(manager.getMessages("a1")).toEqual([]);
    await expect(manager.rollbackAgent("a1")).rejects.toThrow(/Nothing to roll back/);
  });

  it("refuses while a turn is running", async () => {
    const { manager } = await makeAgent({ streaming: true });
    await expect(manager.rollbackAgent("a1")).rejects.toThrow(/current turn/);
  });

  it("refuses for an agent that isn't running", async () => {
    const { manager } = await makeAgent();
    await expect(manager.rollbackAgent("nope")).rejects.toThrow(/not running/);
  });

  it("reports a rollback an extension cancelled, and leaves the chat alone", async () => {
    const { manager } = await makeAgent({ cancel: true });
    await expect(manager.rollbackAgent("a1")).rejects.toThrow(/cancelled/);
    expect(manager.getMessages("a1").at(-1)).toMatchObject({ blocked: true });
  });

  it("rejects a timestamp that is no longer in the chat", async () => {
    const { manager } = await makeAgent();
    await expect(manager.rollbackAgent("a1", { beforeTs: 12345 })).rejects.toThrow(/no longer part/);
  });
});
