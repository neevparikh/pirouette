/**
 * Auto-named chats (the dashboard's bare `@ <message>`).
 *
 * The name must come from the *same model the chat will run on* — the
 * requested model if one was given, otherwise PIROUETTE_DEFAULT_MODEL —
 * and naming problems must never block the chat from being created.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentManager } from "../agent-manager.js";
import { ProjectManager } from "../project-manager.js";
import { StateManager } from "../state.js";
import type { AgentConfig } from "../types.js";

interface FakeModel {
  provider: string;
  id: string;
}

async function makeManager(opts: { reply?: string; fail?: Error } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "pirouette-autoname-test-"));
  const stateManager = new StateManager(dir);
  const projectManager = new ProjectManager(stateManager, dir);
  await projectManager.ensureDefaultProject();
  const manager = new AgentManager(stateManager, projectManager, dir);

  const completions: Array<{ model: FakeModel; context: { systemPrompt: string; messages: Array<{ content: string }> } }> = [];
  const internals = manager as unknown as Record<string, unknown>;
  internals.ensureResourceLoader = async () => ({});
  internals.checkProviderAuth = async () => ({ ok: true });
  internals.modelRegistry = {
    find: (provider: string, id: string): FakeModel => ({ provider, id }),
  };
  internals.modelRuntime = {
    getAvailable: async () => [],
    completeSimple: async (model: FakeModel, context: (typeof completions)[number]["context"]) => {
      completions.push({ model, context });
      if (opts.fail) throw opts.fail;
      return { content: [{ type: "text", text: opts.reply ?? "fix-flaky-login" }], stopReason: "stop" };
    },
  };
  // Don't boot a real pi session; just record what it would have started.
  const started: AgentConfig[] = [];
  internals.startSession = async (config: AgentConfig) => {
    started.push(config);
  };
  return { manager, stateManager, completions, started };
}

const savedDefault = process.env.PIROUETTE_DEFAULT_MODEL;
afterEach(() => {
  if (savedDefault === undefined) delete process.env.PIROUETTE_DEFAULT_MODEL;
  else process.env.PIROUETTE_DEFAULT_MODEL = savedDefault;
});

describe("AgentManager auto-named chats", () => {
  it("names the chat with the host default model when none is requested", async () => {
    process.env.PIROUETTE_DEFAULT_MODEL = "acme/default-model";
    const { manager, completions, started } = await makeManager();

    const config = await manager.createAgent({ nameFromMessage: "the login test flakes in CI" });

    expect(config.name).toBe("fix-flaky-login");
    expect(config.branchName).toMatch(/^agent\/fix-flaky-login-/);
    expect(completions).toHaveLength(1);
    expect(completions[0].model).toEqual({ provider: "acme", id: "default-model" });
    expect(completions[0].context.messages[0].content).toBe("the login test flakes in CI");
    expect(started).toHaveLength(1);
  });

  it("names the chat with the requested model when one is given", async () => {
    process.env.PIROUETTE_DEFAULT_MODEL = "acme/default-model";
    const { manager, completions } = await makeManager();

    const config = await manager.createAgent({
      nameFromMessage: "anything",
      model: "other/picked-model",
    });

    expect(completions[0].model).toEqual({ provider: "other", id: "picked-model" });
    expect(config.model).toBe("other/picked-model");
  });

  it("avoids an existing chat's name", async () => {
    process.env.PIROUETTE_DEFAULT_MODEL = "acme/default-model";
    const { manager } = await makeManager();
    await manager.createAgent({ name: "fix-flaky-login" });

    const config = await manager.createAgent({ nameFromMessage: "again" });
    expect(config.name).toBe("fix-flaky-login-2");
  });

  it("falls back to the message text when the model call fails", async () => {
    process.env.PIROUETTE_DEFAULT_MODEL = "acme/default-model";
    const { manager, started } = await makeManager({ fail: new Error("overloaded") });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const config = await manager.createAgent({ nameFromMessage: "Add dark mode toggle" });
    expect(config.name).toBe("add-dark-mode-toggle");
    expect(started).toHaveLength(1);
  });

  it("still requires a name when there is no message to name from", async () => {
    const { manager } = await makeManager();
    await expect(manager.createAgent({ nameFromMessage: "   " })).rejects.toThrow(
      /name is required/,
    );
  });
});
