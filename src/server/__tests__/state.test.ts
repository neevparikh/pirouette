/**
 * Regression tests for state-file crash-consistency.
 *
 * Two interacting bugs in older versions of `state.ts`:
 *   1. `save()` used `writeFile()` directly, which is non-atomic. A
 *      process killed mid-save (SIGHUP from tmux kill-session, OOM,
 *      container restart) would leave a half-written, unparseable JSON
 *      file on disk.
 *   2. `load()` swallowed all errors and silently fell back to empty
 *      state. The next `save()` would then overwrite the corrupted file
 *      with a valid empty one, permanently destroying the original
 *      data with no log line, no warning, no recovery path.
 *
 * Today:
 *   - `save()` writes to `<file>.tmp` and renames into place. Rename is
 *     atomic on POSIX same-filesystem moves; readers see either the
 *     previous file or the new one.
 *   - `load()` distinguishes ENOENT (first run, OK) from any other
 *     error. On parse failure the file is renamed to
 *     `pirouette-state.json.broken-<ts>` and `load()` throws so the
 *     server refuses to start.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StateManager } from "../state.js";
import { DEFAULT_PROJECT_NAME, type AgentConfig, type ProjectConfig } from "../types.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "pir-state-test-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function makeAgent(id: string, name: string): AgentConfig {
  return {
    id,
    name,
    projectName: DEFAULT_PROJECT_NAME,
    worktreePath: `/tmp/${name}`,
    branchName: null,
    sessionDir: `/tmp/${name}/sessions`,
    state: "idle",
    createdAt: "2026-04-29T00:00:00.000Z",
    lastActivity: "2026-04-29T00:00:00.000Z",
    model: null,
    thinkingLevel: "off",
    usage: {
      costUsd: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 0,
    },
    errorMessage: null,
    parentAgentId: null,
  };
}

function makeProject(name: string): ProjectConfig {
  return {
    name,
    repoUrl: null,
    repoPath: `/tmp/${name}/repo`,
    worktreesDir: `/tmp/${name}/worktrees`,
    defaultBranch: "main",
    createdAt: "2026-04-29T00:00:00.000Z",
  };
}

describe("StateManager.load — first-run path (ENOENT)", () => {
  it("returns empty state when no file exists; does not throw", async () => {
    const sm = new StateManager(stateDir);
    await sm.load();
    expect(sm.getAgents()).toEqual([]);
    expect(sm.getProjects()).toEqual([]);
  });
});

describe("StateManager.load — corrupted file path", () => {
  it("throws and quarantines when the file is invalid JSON", async () => {
    // Simulate a half-written save: write garbage that JSON.parse will
    // reject.
    writeFileSync(path.join(stateDir, "pirouette-state.json"), '{"agents": {"a":');

    const sm = new StateManager(stateDir);
    await expect(sm.load()).rejects.toThrow(/corrupted/);

    // Original file should be renamed to a *.broken-<ts> path; the
    // canonical path is gone (so the next save creates a fresh file).
    const files = readdirSync(stateDir);
    const broken = files.filter((f) => f.startsWith("pirouette-state.json.broken-"));
    expect(broken.length).toBe(1);
    expect(files.includes("pirouette-state.json")).toBe(false);

    // Quarantined file still has the original (bad) bytes intact.
    const quarantined = readFileSync(path.join(stateDir, broken[0]), "utf8");
    expect(quarantined).toBe('{"agents": {"a":');
  });

  it("throws on read errors that aren't ENOENT (e.g. file is a directory)", async () => {
    // Create a directory at the state-file path — readFile() will return
    // EISDIR. We want this surfaced, not silently swallowed.
    const filePath = path.join(stateDir, "pirouette-state.json");
    const fs = await import("node:fs");
    fs.mkdirSync(filePath);

    const sm = new StateManager(stateDir);
    await expect(sm.load()).rejects.toThrow();
  });
});

describe("StateManager.save — atomicity", () => {
  it("writes via <file>.tmp and renames into place", async () => {
    const sm = new StateManager(stateDir);
    await sm.load();
    sm.putAgent(makeAgent("abc12345", "smoke"));
    sm.putProject(makeProject(DEFAULT_PROJECT_NAME));
    await sm.flush();

    // Canonical file exists with the agent + project.
    const filePath = path.join(stateDir, "pirouette-state.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    expect(parsed.agents.abc12345?.name).toBe("smoke");
    expect(parsed.projects[DEFAULT_PROJECT_NAME]?.name).toBe(DEFAULT_PROJECT_NAME);

    // Tmp file should be gone after rename.
    const files = readdirSync(stateDir);
    expect(files.includes("pirouette-state.json.tmp")).toBe(false);
  });

  it("survives a stale tmp file from a previous crashed save", async () => {
    // A previous save crashed AFTER writing to .tmp but BEFORE rename.
    // Next save should overwrite the tmp file successfully.
    const tmpPath = path.join(stateDir, "pirouette-state.json.tmp");
    writeFileSync(tmpPath, '{"agents": {"OLD"');  // garbage

    const sm = new StateManager(stateDir);
    await sm.load();   // ENOENT for the canonical file -> empty state
    sm.putAgent(makeAgent("def67890", "fresh"));
    await sm.flush();

    // Final file should have only the new agent; tmp should be gone.
    const filePath = path.join(stateDir, "pirouette-state.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    expect(Object.keys(parsed.agents)).toEqual(["def67890"]);
    expect(readdirSync(stateDir).includes("pirouette-state.json.tmp")).toBe(false);
  });
});

describe("StateManager round-trip (save + reload)", () => {
  it("persists agents + projects across StateManager instances", async () => {
    const sm1 = new StateManager(stateDir);
    await sm1.load();
    sm1.putAgent(makeAgent("11111111", "alpha"));
    sm1.putAgent(makeAgent("22222222", "beta"));
    sm1.putProject(makeProject(DEFAULT_PROJECT_NAME));
    await sm1.flush();

    const sm2 = new StateManager(stateDir);
    await sm2.load();
    expect(sm2.getAgents().map((a) => a.name).sort()).toEqual(["alpha", "beta"]);
    expect(sm2.getProject(DEFAULT_PROJECT_NAME)?.name).toBe(DEFAULT_PROJECT_NAME);
  });

  it("flush() is a no-op when nothing is dirty", async () => {
    const sm = new StateManager(stateDir);
    await sm.load();
    await sm.flush();   // should not throw, should not create a file

    expect(readdirSync(stateDir)).toEqual([]);
  });
});
