/** Unit tests for the helpers in host.ts: shell quoting, the `pru logs`
 *  `--lines` validator, and the logs command builder. These are the only bits
 *  of host.ts that don't require a live SSH connection — and shellQuote /
 *  validateLines are the only guards on values interpolated into remote
 *  shell commands, so they're worth pinning down. */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Host, packTarball, shellQuote, validateLines } from "../host.js";
import type { EffectiveHostConfig } from "../../../config.js";

function hostCfg(over: Partial<EffectiveHostConfig> = {}): EffectiveHostConfig {
  return {
    name: "test",
    ssh_alias: "test-alias",
    user: "u",
    persistent_root: "/data",
    home_dir: "/data/home/u",
    data_dir: "/data/pirouette/data",
    bind_host: "127.0.0.1",
    adopt: false,
    port: 7777,
    npm_package: "@scope/pkg@latest",
    default_model: "",
    default_thinking_level: "",
    public_url: "",
    allowed_hosts: [],
    dotfiles: { clone_url: "", authorized_keys_url: "" },
    tailscale: { enabled: false, hostname: "pirouette-test", state_persistent: true },
    ...over,
  };
}

describe("shellQuote", () => {
  it("wraps a plain string in single quotes", () => {
    expect(shellQuote("/data/logs")).toBe("'/data/logs'");
  });

  it("escapes embedded single quotes via the '\\'' idiom", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it("neutralizes shell metacharacters (injection barrier)", () => {
    // The dangerous payload ends up fully inside single quotes -> inert.
    expect(shellQuote("; rm -rf /")).toBe("'; rm -rf /'");
    expect(shellQuote("$(whoami)")).toBe("'$(whoami)'");
  });
});

describe("validateLines", () => {
  it("defaults to 200 when undefined", () => {
    expect(validateLines(undefined)).toBe("200");
  });

  it("passes through a valid positive integer", () => {
    expect(validateLines("50")).toBe("50");
  });

  it("floors a fractional value", () => {
    expect(validateLines("12.9")).toBe("12");
  });

  it.each(["abc", "0", "-5", "100001"])("rejects %s", (bad) => {
    expect(() => validateLines(bad)).toThrow(/--lines/);
  });
});

describe("buildLogsCommand", () => {
  const host = new Host(hostCfg());

  it("tails the server log by default and respects --follow + --lines", () => {
    const { command, sshAlias } = host.buildLogsCommand({ lines: "10", follow: true });
    expect(sshAlias).toBe("test-alias");
    expect(command).toContain("/data/pirouette/data/logs/pirouette.log");
    expect(command).toContain("tail -n 10 -f");
  });

  it("--entrypoint targets the bootstrap log under home_dir", () => {
    const { command } = host.buildLogsCommand({ entrypoint: true });
    expect(command).toContain("/data/home/u/logs/bootstrap.log");
    expect(command).not.toContain("pirouette.log");
  });

  it("--journal reads the systemd journal", () => {
    const { command } = host.buildLogsCommand({ journal: true, lines: "10" });
    expect(command).toContain("journalctl -u pirouette");
    expect(command).toContain("-n 10");
  });

  it("--tmux is a deprecated alias for --journal", () => {
    const { command } = host.buildLogsCommand({ tmux: true });
    expect(command).toContain("journalctl -u pirouette");
    expect(command).not.toContain("tmux capture-pane");
  });

  it("rejects a bad --lines value", () => {
    expect(() => host.buildLogsCommand({ lines: "nope" })).toThrow(/--lines/);
  });
});

describe("packTarball", () => {
  it("returns the tarball path even when a lifecycle script writes to stdout", () => {
    const pkgDir = mkdtempSync(path.join(os.tmpdir(), "pirouette-pack-test-"));
    let tarball: string | undefined;
    try {
      writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({
          name: "@scope/pack-fixture",
          version: "1.2.3",
          scripts: { prepare: "echo '  vendored something (not json)'" },
        }),
      );
      writeFileSync(path.join(pkgDir, "index.js"), "");
      tarball = packTarball(pkgDir);
      expect(path.basename(tarball)).toBe("scope-pack-fixture-1.2.3.tgz");
      expect(existsSync(tarball)).toBe(true);
    } finally {
      rmSync(pkgDir, { recursive: true, force: true });
      if (tarball) rmSync(path.dirname(tarball), { recursive: true, force: true });
    }
  });
});
