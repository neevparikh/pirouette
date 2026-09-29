/**
 * Agent-to-agent messages: delivered as a pi custom message carrying the
 * sender, rendered as "from <agent>" in history and on the live event
 * stream, and never as if the user had typed them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentManager } from "../agent-manager.js";
import {
  AGENT_MESSAGE_TYPE,
  agentMessageDetails,
  agentMessageText,
} from "../agent-message.js";
import { normalizeEvent } from "../normalize.js";
import { ProjectManager } from "../project-manager.js";
import { StateManager } from "../state.js";
import type { AgentConfig } from "../types.js";

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

const FROM = { id: "a1b2c3d4", name: "parent" };

function makeSession() {
  let isStreaming = false;
  const customCalls: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const promptCalls: string[] = [];
  let finishTurn: (() => void) | null = null;
  return {
    get isStreaming() {
      return isStreaming;
    },
    customCalls,
    promptCalls,
    messages: [] as unknown[],
    _extensionRunner: { getCommand: () => undefined } as Record<string, unknown>,
    sendCustomMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
      customCalls.push({ message, options });
      if (!isStreaming && options?.triggerTurn) {
        isStreaming = true;
        return new Promise<void>((resolve) => {
          finishTurn = () => {
            isStreaming = false;
            resolve();
          };
        });
      }
      return Promise.resolve();
    },
    prompt(text: string) {
      promptCalls.push(text);
      return Promise.resolve();
    },
    async steer() {},
    async followUp() {},
    finish() {
      finishTurn?.();
    },
  };
}

async function makeManager(session: ReturnType<typeof makeSession>) {
  const dir = await mkdtemp(path.join(tmpdir(), "pirouette-test-"));
  const stateManager = new StateManager(dir);
  const manager = new AgentManager(stateManager, new ProjectManager(stateManager, dir), dir);
  const config = {
    id: "deadbeef",
    name: "child",
    projectName: "test",
    worktreePath: dir,
    state: "idle" as const,
    createdAt: Date.now(),
    sessionDir: dir,
  } as unknown as AgentConfig;
  stateManager.putAgent(config);
  const handle = { config, session, unsubscribe: () => {}, activeToolCalls: new Set<string>() };
  (manager as unknown as { handles: Map<string, unknown> }).handles.set("deadbeef", handle);
  return manager;
}

describe("agentMessageText", () => {
  it("names the sender, says it isn't the user, and gives the reply command", () => {
    const text = agentMessageText(FROM, "please run the tests");
    expect(text).toContain('agent "parent" (a1b2c3d4)');
    expect(text).toContain("not typed by the user");
    expect(text).toContain('pru send a1b2c3d4 "<reply>"');
    expect(text.endsWith("\n\nplease run the tests")).toBe(true);
  });
});

describe("agentMessageDetails", () => {
  it("rejects other custom types and malformed details", () => {
    expect(agentMessageDetails({ role: "custom", customType: "other", details: { from: FROM, body: "x" } })).toBeNull();
    expect(agentMessageDetails({ role: "custom", customType: AGENT_MESSAGE_TYPE, details: { body: "x" } })).toBeNull();
    expect(agentMessageDetails({ role: "user", customType: AGENT_MESSAGE_TYPE, details: { from: FROM, body: "x" } })).toBeNull();
    expect(
      agentMessageDetails({ role: "custom", customType: AGENT_MESSAGE_TYPE, details: { from: FROM, body: "x" } }),
    ).toEqual({ from: FROM, body: "x" });
  });
});

describe("sendMessage with a sender", () => {
  it("starts a turn with a custom message when idle, not a user prompt", async () => {
    const session = makeSession();
    const manager = await makeManager(session);
    const sent = manager.sendMessage("deadbeef", "hello", { from: FROM });
    await vi.waitFor(() => expect(session.customCalls).toHaveLength(1));
    const { message, options } = session.customCalls[0];
    expect(options).toEqual({ triggerTurn: true });
    expect(message.customType).toBe(AGENT_MESSAGE_TYPE);
    expect(message.display).toBe(true);
    expect(message.details).toEqual({ from: FROM, body: "hello" });
    expect((message.content as Array<{ text?: string }>)[0].text).toBe(agentMessageText(FROM, "hello"));
    expect(session.promptCalls).toEqual([]);
    session.finish();
    await sent;
  });

  it("queues on the requested mode when the recipient is mid-turn", async () => {
    const session = makeSession();
    const manager = await makeManager(session);
    const first = manager.sendMessage("deadbeef", "first", { from: FROM });
    await vi.waitFor(() => expect(session.isStreaming).toBe(true));
    await manager.sendMessage("deadbeef", "second", { from: FROM, mode: "followUp" });
    expect(session.customCalls[1].options).toEqual({ deliverAs: "followUp" });
    session.finish();
    await first;
  });

  it("does not treat a peer's slash text as an extension command", async () => {
    const session = makeSession();
    const manager = await makeManager(session);
    const sent = manager.sendMessage("deadbeef", "/fast", { from: FROM });
    await vi.waitFor(() => expect(session.customCalls).toHaveLength(1));
    expect(session.promptCalls).toEqual([]);
    session.finish();
    await sent;
  });

  it("runs extensions' input hooks, which custom messages would skip", async () => {
    const session = makeSession();
    const seen: unknown[] = [];
    Object.assign(session._extensionRunner, {
      hasHandlers: (name: string) => name === "input",
      emitInput: async (...args: unknown[]) => {
        seen.push(args);
        return { action: "transform", text: "cleaned" };
      },
    });
    const manager = await makeManager(session);
    const sent = manager.sendMessage("deadbeef", "dirty", { from: FROM });
    await vi.waitFor(() => expect(session.customCalls).toHaveLength(1));
    expect(seen).toEqual([["dirty", undefined, "rpc", undefined]]);
    expect(session.customCalls[0].message.details).toEqual({ from: FROM, body: "cleaned" });
    session.finish();
    await sent;
  });

  it("an input hook that handles the message blocks it and parks the agent in error", async () => {
    const session = makeSession();
    Object.assign(session._extensionRunner, {
      hasHandlers: () => true,
      emitInput: async () => ({ action: "handled" }),
    });
    const manager = await makeManager(session);
    await expect(manager.sendMessage("deadbeef", "bad", { from: FROM })).rejects.toThrow(/blocked/);
    expect(session.customCalls).toEqual([]);
    expect(manager.getAgent("deadbeef")?.state).toBe("error");
  });

  it("without a sender, still sends a plain user prompt", async () => {
    const session = makeSession();
    const manager = await makeManager(session);
    await manager.sendMessage("deadbeef", "hi");
    expect(session.promptCalls).toEqual(["hi"]);
    expect(session.customCalls).toEqual([]);
  });
});

describe("rendering agent messages", () => {
  const custom = {
    role: "custom",
    customType: AGENT_MESSAGE_TYPE,
    content: [{ type: "text", text: agentMessageText(FROM, "body text") }],
    display: true,
    details: { from: FROM, body: "body text" },
    timestamp: 5,
  };

  it("history shows the body as a user row with `from`, without the header", async () => {
    const session = makeSession();
    session.messages.push(custom, { role: "custom", customType: "other", content: "x", display: false, timestamp: 6 });
    const manager = await makeManager(session);
    expect(manager.getMessages("deadbeef")).toEqual([
      { role: "user", content: "body text", from: FROM, ts: 5 },
    ]);
  });

  it("the live event carries the same shape", () => {
    expect(normalizeEvent({ type: "message_end", message: custom } as never)).toEqual({
      type: "message_end",
      role: "user",
      text: "body text",
      from: FROM,
    });
  });
});
