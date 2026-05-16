/** Regression tests for state file shape + migration.
 *
 *  state.ts handles three things that have to keep working across releases:
 *    1. `~/.pirouette/ec2.json` (the pre-provider-abstraction filename)
 *       migrates forward to `host.json` on first read.
 *    2. Records without a `kind` field get stamped `kind: "ec2"` when
 *       they look non-empty (have at least one EC2 identifier).
 *    3. Multi-provider records (ec2 + byo-host fields) round-trip.
 *
 *  All tests sandbox `~/.pirouette/` by pointing $HOME at a tmpdir so they
 *  don't touch the developer's real state file.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearRemoteState,
  loadRemoteState,
  saveRemoteState,
  stateFilePath,
  updateRemoteState,
  type RemoteState,
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

function legacyEc2Json(): string {
  return path.join(sandbox, ".pirouette", "ec2.json");
}

function newHostJson(): string {
  return path.join(sandbox, ".pirouette", "host.json");
}

function writeJson(filePath: string, body: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(body));
}

describe("remote state — first run / empty", () => {
  it("returns {} when no state file exists", () => {
    expect(loadRemoteState()).toEqual({});
  });

  it("does not create files on read", () => {
    loadRemoteState();
    expect(existsSync(newHostJson())).toBe(false);
    expect(existsSync(legacyEc2Json())).toBe(false);
  });

  it("clearRemoteState writes an empty record to host.json", () => {
    clearRemoteState();
    expect(existsSync(newHostJson())).toBe(true);
    const written = JSON.parse(readFileSync(newHostJson(), "utf8")) as RemoteState;
    expect(written.instanceId).toBeUndefined();
    expect(written.sshAlias).toBeUndefined();
    expect(typeof written.updatedAt).toBe("string");
  });
});

describe("remote state — legacy ec2.json migration", () => {
  it("renames ec2.json -> host.json on first read", () => {
    writeJson(legacyEc2Json(), {
      instanceId: "i-abc123",
      privateIp: "10.0.0.5",
      volumeId: "vol-xyz",
    });
    expect(existsSync(legacyEc2Json())).toBe(true);
    expect(existsSync(newHostJson())).toBe(false);

    const state = loadRemoteState();

    expect(state.instanceId).toBe("i-abc123");
    expect(state.privateIp).toBe("10.0.0.5");
    expect(state.volumeId).toBe("vol-xyz");
    expect(existsSync(legacyEc2Json())).toBe(false);
    expect(existsSync(newHostJson())).toBe(true);
  });

  it("stamps kind: 'ec2' on migrated non-empty records", () => {
    writeJson(legacyEc2Json(), { instanceId: "i-abc123" });
    const state = loadRemoteState();
    expect(state.kind).toBe("ec2");
  });

  it("does NOT stamp kind on a migrated empty record", () => {
    writeJson(legacyEc2Json(), {});
    const state = loadRemoteState();
    expect(state.kind).toBeUndefined();
  });

  it("new host.json wins if both files exist", () => {
    // Pre-existing host.json means migration already happened. We must NOT
    // overwrite the newer file with the stale legacy one.
    writeJson(legacyEc2Json(), { instanceId: "i-old-stale" });
    writeJson(newHostJson(), { kind: "ec2", instanceId: "i-current" });
    const state = loadRemoteState();
    expect(state.instanceId).toBe("i-current");
    // The legacy file is left alone (we only rename when newHostJson is absent).
    expect(existsSync(legacyEc2Json())).toBe(true);
  });
});

describe("remote state — kind discrimination", () => {
  it("preserves an explicit 'ec2' kind on round-trip", () => {
    saveRemoteState({ kind: "ec2", instanceId: "i-1", privateIp: "10.0.0.1" });
    const loaded = loadRemoteState();
    expect(loaded.kind).toBe("ec2");
    expect(loaded.instanceId).toBe("i-1");
  });

  it("preserves byo-host fields on round-trip", () => {
    saveRemoteState({
      kind: "byo-host",
      sshAlias: "gpu",
      sshUser: "neev",
      persistentRoot: "/data",
      homeDir: "/data/home/neev",
      dataDir: "/data/pirouette/data",
    });
    const loaded = loadRemoteState();
    expect(loaded.kind).toBe("byo-host");
    expect(loaded.sshAlias).toBe("gpu");
    expect(loaded.persistentRoot).toBe("/data");
    expect(loaded.homeDir).toBe("/data/home/neev");
    expect(loaded.dataDir).toBe("/data/pirouette/data");
  });

  it("updateRemoteState merges patches without dropping kind", () => {
    saveRemoteState({ kind: "byo-host", sshAlias: "gpu", sshUser: "neev" });
    const merged = updateRemoteState({ dataDir: "/data/pirouette/data" });
    expect(merged.kind).toBe("byo-host");
    expect(merged.sshAlias).toBe("gpu");
    expect(merged.dataDir).toBe("/data/pirouette/data");
  });

  it("stamps updatedAt on every save", async () => {
    saveRemoteState({ kind: "ec2", instanceId: "i-2" });
    const first = loadRemoteState().updatedAt;
    expect(first).toBeTruthy();
    await new Promise((r) => setTimeout(r, 10));
    updateRemoteState({ privateIp: "10.0.0.99" });
    const second = loadRemoteState().updatedAt;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });
});

describe("remote state — file paths", () => {
  it("stateFilePath points at host.json under ~/.pirouette", () => {
    expect(stateFilePath()).toBe(path.join(sandbox, ".pirouette", "host.json"));
  });
});

describe("remote state — multi-config (--config / $PIROUETTE_CONFIG)", () => {
  let prevConfig: string | undefined;
  let prevState: string | undefined;
  beforeEach(() => {
    prevConfig = process.env.PIROUETTE_CONFIG;
    prevState = process.env.PIROUETTE_STATE;
  });
  afterEach(() => {
    if (prevConfig !== undefined) process.env.PIROUETTE_CONFIG = prevConfig;
    else delete process.env.PIROUETTE_CONFIG;
    if (prevState !== undefined) process.env.PIROUETTE_STATE = prevState;
    else delete process.env.PIROUETTE_STATE;
  });

  it("default config keeps historical state path ~/.pirouette/host.json", () => {
    delete process.env.PIROUETTE_CONFIG;
    delete process.env.PIROUETTE_STATE;
    expect(stateFilePath()).toBe(path.join(sandbox, ".pirouette", "host.json"));
  });

  it("custom config -> sibling host.json with stem-matching name", () => {
    process.env.PIROUETTE_CONFIG = "/tmp/cfgs/ec2.toml";
    delete process.env.PIROUETTE_STATE;
    expect(stateFilePath()).toBe("/tmp/cfgs/ec2.host.json");
  });

  it("different custom configs in same dir get separate state files", () => {
    process.env.PIROUETTE_CONFIG = "/tmp/cfgs/byo-host.toml";
    delete process.env.PIROUETTE_STATE;
    expect(stateFilePath()).toBe("/tmp/cfgs/byo-host.host.json");
    process.env.PIROUETTE_CONFIG = "/tmp/cfgs/ec2.toml";
    expect(stateFilePath()).toBe("/tmp/cfgs/ec2.host.json");
  });

  it("PIROUETTE_STATE env var wins outright", () => {
    process.env.PIROUETTE_CONFIG = "/tmp/cfgs/ec2.toml";
    process.env.PIROUETTE_STATE = "/tmp/explicit/state.json";
    expect(stateFilePath()).toBe("/tmp/explicit/state.json");
  });

  it("PIROUETTE_CONFIG with ~/ expands", () => {
    process.env.PIROUETTE_CONFIG = "~/my-cfgs/ec2.toml";
    delete process.env.PIROUETTE_STATE;
    expect(stateFilePath()).toBe(path.join(sandbox, "my-cfgs", "ec2.host.json"));
  });
});
