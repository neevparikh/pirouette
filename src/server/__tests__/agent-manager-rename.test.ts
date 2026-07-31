/**
 * Renaming a chat.
 *
 * A chat's name is chosen before anyone knows what the work will turn into
 * ("followups"), and the useful label often only exists later ("pr-42").
 * `renameAgent` is therefore display-only: it must NOT touch the id, the
 * worktree, the branch or the session directory, all of which were slugged
 * from the original name at creation time and are load-bearing (git
 * registers worktrees by path; pi finds history by session dir).
 *
 * These tests pin that contract, plus the live-handle update — a running
 * agent's cached config is what log lines and `getRunningAgents()` read,
 * so a rename that only hits the state file would show two names at once.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentManager } from "../agent-manager.js";
import { ProjectManager } from "../project-manager.js";
import { StateManager } from "../state.js";
import type { AgentConfig } from "../types.js";

async function makeManager() {
  const dir = await mkdtemp(path.join(tmpdir(), "pirouette-rename-test-"));
  const stateManager = new StateManager(dir);
  const projectManager = new ProjectManager(stateManager, dir);
  const manager = new AgentManager(stateManager, projectManager, dir);
  return { manager, stateManager, dir };
}

function putAgent(stateManager: StateManager, dir: string, id: string, name: string) {
  const config = {
    id,
    name,
    projectName: "proj",
    worktreePath: path.join(dir, `worktrees/${name}-${id}`),
    branchName: `agent/${name}-${id}`,
    sessionDir: path.join(dir, `sessions/${name}-${id}`),
    state: "waiting_input" as const,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
  } as unknown as AgentConfig;
  stateManager.putAgent(config);
  return config;
}

describe("AgentManager.renameAgent", () => {
  it("changes the display name and nothing else", async () => {
    const { manager, stateManager, dir } = await makeManager();
    const before = { ...putAgent(stateManager, dir, "aaaa1111", "followups") };

    const updated = manager.renameAgent("aaaa1111", "pr-42");

    expect(updated?.name).toBe("pr-42");
    expect(stateManager.getAgent("aaaa1111")?.name).toBe("pr-42");
    // The slug-derived identity survives untouched.
    expect(updated?.id).toBe(before.id);
    expect(updated?.worktreePath).toBe(before.worktreePath);
    expect(updated?.branchName).toBe(before.branchName);
    expect(updated?.sessionDir).toBe(before.sessionDir);
    expect(updated?.projectName).toBe(before.projectName);
  });

  it("trims surrounding whitespace and rejects an empty name", async () => {
    const { manager, stateManager, dir } = await makeManager();
    putAgent(stateManager, dir, "bbbb2222", "chat");

    manager.renameAgent("bbbb2222", "  pr-7  ");
    expect(stateManager.getAgent("bbbb2222")?.name).toBe("pr-7");

    expect(() => manager.renameAgent("bbbb2222", "   ")).toThrow(/name is required/);
    expect(stateManager.getAgent("bbbb2222")?.name).toBe("pr-7");
  });

  it("updates the live handle's cached config too", async () => {
    const { manager, stateManager, dir } = await makeManager();
    const config = putAgent(stateManager, dir, "cccc3333", "chat");
    const handle = {
      config,
      session: {} as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
      unsubscribe: () => {},
    };
    (manager as unknown as { handles: Map<string, typeof handle> }).handles.set(
      "cccc3333",
      handle,
    );

    manager.renameAgent("cccc3333", "pr-99");

    expect(handle.config.name).toBe("pr-99");
    expect(manager.getRunningAgents().map((a) => a.name)).toEqual(["pr-99"]);
  });

  it("returns null for an unknown agent", async () => {
    const { manager } = await makeManager();
    expect(manager.renameAgent("nope0000", "whatever")).toBeNull();
  });

  it("makes the new name resolvable as an agent ref (and the old one not)", async () => {
    const { manager, stateManager, dir } = await makeManager();
    putAgent(stateManager, dir, "dddd4444", "followups");

    manager.renameAgent("dddd4444", "pr-42");

    const resolved = manager.resolveAgentRef("pr-42");
    expect(resolved && "id" in resolved ? resolved.id : null).toBe("dddd4444");
    expect(manager.resolveAgentRef("followups")).toBeNull();
  });
});
