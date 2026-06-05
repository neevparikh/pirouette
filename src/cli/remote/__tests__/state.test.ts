/** Tests for per-host state files (`~/.pirouette/state/<host>.json`).
 *
 *  All tests sandbox `~/.pirouette/` by pointing $HOME at a tmpdir so they
 *  don't touch the developer's real state.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearHostState,
  hasHostState,
  loadHostState,
  saveHostState,
  stateFilePath,
  updateHostState,
} from "../state.js";

let sandbox: string;
let prevHome: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "pir-state-test-"));
  prevHome = process.env.HOME;
  process.env.HOME = sandbox;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("host state — first run / empty", () => {
  it("returns {} and reports not-set-up when no file exists", () => {
    expect(loadHostState("gpu")).toEqual({});
    expect(hasHostState("gpu")).toBe(false);
  });

  it("does not create files on read", () => {
    loadHostState("gpu");
    expect(existsSync(stateFilePath("gpu"))).toBe(false);
  });
});

describe("host state — round-trip + paths", () => {
  it("stateFilePath points at ~/.pirouette/state/<host>.json", () => {
    expect(stateFilePath("gpu")).toBe(
      path.join(sandbox, ".pirouette", "state", "gpu.json"),
    );
  });

  it("saves and reloads a record, stamping updatedAt", () => {
    saveHostState("gpu", {
      setupAt: "2026-06-05T00:00:00.000Z",
      sshAlias: "gpu",
      user: "neev",
      dataDir: "/data/pirouette/data",
      homeDir: "/data/home/neev",
    });
    expect(hasHostState("gpu")).toBe(true);
    const loaded = loadHostState("gpu");
    expect(loaded.sshAlias).toBe("gpu");
    expect(loaded.dataDir).toBe("/data/pirouette/data");
    expect(typeof loaded.updatedAt).toBe("string");
  });

  it("keeps separate files per host", () => {
    saveHostState("gpu", { sshAlias: "gpu" });
    saveHostState("ec2", { sshAlias: "pirouette-container" });
    expect(loadHostState("gpu").sshAlias).toBe("gpu");
    expect(loadHostState("ec2").sshAlias).toBe("pirouette-container");
  });

  it("updateHostState merges patches", () => {
    saveHostState("gpu", { setupAt: "t0", sshAlias: "gpu" });
    const merged = updateHostState("gpu", { dataDir: "/data" });
    expect(merged.setupAt).toBe("t0");
    expect(merged.sshAlias).toBe("gpu");
    expect(merged.dataDir).toBe("/data");
  });

  it("stamps a fresh updatedAt on every save", async () => {
    saveHostState("gpu", { setupAt: "t0" });
    const first = loadHostState("gpu").updatedAt;
    await new Promise((r) => setTimeout(r, 10));
    updateHostState("gpu", { dataDir: "/data" });
    const second = loadHostState("gpu").updatedAt;
    expect(second).not.toBe(first);
  });

  it("clearHostState removes the file", () => {
    saveHostState("gpu", { setupAt: "t0" });
    expect(hasHostState("gpu")).toBe(true);
    clearHostState("gpu");
    expect(hasHostState("gpu")).toBe(false);
    expect(existsSync(stateFilePath("gpu"))).toBe(false);
  });

  it("clearHostState on a missing file is a no-op", () => {
    expect(() => clearHostState("never")).not.toThrow();
  });

  it("tolerates a corrupt state file (returns {})", () => {
    saveHostState("gpu", { setupAt: "t0" });
    // Corrupt it.
    const p = stateFilePath("gpu");
    writeFileSync(p, "not json{");
    expect(loadHostState("gpu")).toEqual({});
  });
});

describe("loadHostState — corrupt content via direct write", () => {
  it("reads a hand-written valid file", () => {
    saveHostState("gpu", { setupAt: "t0", sshAlias: "gpu" });
    const raw = JSON.parse(readFileSync(stateFilePath("gpu"), "utf8"));
    expect(raw.sshAlias).toBe("gpu");
  });
});
