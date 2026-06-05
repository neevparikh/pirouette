/** Tests for the multi-host config: loading, `[defaults]` inheritance,
 *  per-host overrides, computed dirs/tailscale-hostname, and host selection
 *  (`--host` / `default_host` / sole-host fallback). */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listHostNames,
  loadConfig,
  resetConfigCache,
  resolveHost,
  selectHostName,
} from "../config.js";

let sandbox: string;
let prevHome: string | undefined;
let prevSelected: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "pir-config-test-"));
  prevHome = process.env.HOME;
  prevSelected = process.env.PIROUETTE_SELECTED_HOST;
  process.env.HOME = sandbox;
  delete process.env.PIROUETTE_SELECTED_HOST;
  resetConfigCache();
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  if (prevSelected !== undefined) process.env.PIROUETTE_SELECTED_HOST = prevSelected;
  else delete process.env.PIROUETTE_SELECTED_HOST;
  rmSync(sandbox, { recursive: true, force: true });
  resetConfigCache();
});

function writeUserConfig(body: string): void {
  const dir = path.join(sandbox, ".pirouette");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.toml"), body);
}

describe("resolveHost — defaults + computed values", () => {
  it("computes home_dir and data_dir from persistent_root + user", () => {
    writeUserConfig(`
[defaults]
npm_package = "@scope/pkg@latest"

[hosts.gpu]
ssh_alias = "gpu"
user = "neev"
persistent_root = "/data"
`);
    const { config } = loadConfig();
    const h = resolveHost("gpu", config);
    expect(h.home_dir).toBe("/data/home/neev");
    expect(h.data_dir).toBe("/data/pirouette/data");
    expect(h.npm_package).toBe("@scope/pkg@latest");
    expect(h.bind_host).toBe("127.0.0.1");
    expect(h.adopt).toBe(false);
    expect(h.port).toBe(7777);
    expect(h.tailscale.hostname).toBe("pirouette-gpu");
  });

  it("respects explicit home_dir / data_dir / bind_host / adopt overrides", () => {
    writeUserConfig(`
[defaults]
npm_package = "@scope/pkg@latest"

[hosts.ec2]
ssh_alias = "pirouette-container"
user = "neev"
persistent_root = "/data"
data_dir = "/data"
home_dir = "/home/neev"
bind_host = "0.0.0.0"
adopt = true
`);
    const { config } = loadConfig();
    const h = resolveHost("ec2", config);
    expect(h.home_dir).toBe("/home/neev");
    expect(h.data_dir).toBe("/data");
    expect(h.bind_host).toBe("0.0.0.0");
    expect(h.adopt).toBe(true);
  });

  it("inherits [defaults] scalars but lets a host override them", () => {
    writeUserConfig(`
[defaults]
npm_package = "@scope/pkg@latest"
default_model = "default/model"
port = 7777

[hosts.a]
ssh_alias = "a"
user = "u"
persistent_root = "/data"

[hosts.b]
ssh_alias = "b"
user = "u"
persistent_root = "/data"
default_model = "special/model"
port = 8888
`);
    const { config } = loadConfig();
    expect(resolveHost("a", config).default_model).toBe("default/model");
    expect(resolveHost("a", config).port).toBe(7777);
    expect(resolveHost("b", config).default_model).toBe("special/model");
    expect(resolveHost("b", config).port).toBe(8888);
  });

  it("merges per-host dotfiles over [defaults.dotfiles]", () => {
    writeUserConfig(`
[defaults]
npm_package = "@scope/pkg@latest"

[defaults.dotfiles]
clone_url = "https://example.com/shared.git"
authorized_keys_url = "https://example.com/keys"

[hosts.a]
ssh_alias = "a"
user = "u"
persistent_root = "/data"

[hosts.b]
ssh_alias = "b"
user = "u"
persistent_root = "/data"

[hosts.b.dotfiles]
clone_url = "https://example.com/b.git"
`);
    const { config } = loadConfig();
    const a = resolveHost("a", config);
    expect(a.dotfiles.clone_url).toBe("https://example.com/shared.git");
    const b = resolveHost("b", config);
    // overridden
    expect(b.dotfiles.clone_url).toBe("https://example.com/b.git");
    // inherited from defaults (not overridden per-host)
    expect(b.dotfiles.authorized_keys_url).toBe("https://example.com/keys");
  });

  it("throws when a host is missing required fields", () => {
    writeUserConfig(`
[defaults]
npm_package = "@scope/pkg@latest"

[hosts.bad]
ssh_alias = "bad"
# missing user + persistent_root
`);
    const { config } = loadConfig();
    expect(() => resolveHost("bad", config)).toThrow(/persistent_root/);
    expect(() => resolveHost("bad", config)).toThrow(/\.user/);
  });

  it("throws when npm_package is set nowhere", () => {
    // No packaged pirouette.toml in the sandbox HOME, but loadConfig also
    // reads the repo's pirouette.toml which ships a default npm_package.
    // To exercise the missing case we override it to empty in user config.
    writeUserConfig(`
[defaults]
npm_package = ""

[hosts.x]
ssh_alias = "x"
user = "u"
persistent_root = "/data"
`);
    const { config } = loadConfig();
    expect(() => resolveHost("x", config)).toThrow(/npm_package/);
  });
});

describe("selectHostName", () => {
  function cfgWith(hosts: string[], defaultHost = ""): string {
    const body = [
      defaultHost ? `default_host = "${defaultHost}"` : "",
      `[defaults]`,
      `npm_package = "@scope/pkg@latest"`,
      ...hosts.flatMap((h) => [
        `[hosts.${h}]`,
        `ssh_alias = "${h}"`,
        `user = "u"`,
        `persistent_root = "/data"`,
      ]),
    ].join("\n");
    return body;
  }

  it("uses the explicit name when valid", () => {
    writeUserConfig(cfgWith(["a", "b"]));
    const { config } = loadConfig();
    expect(selectHostName("b", config)).toBe("b");
  });

  it("throws on an unknown explicit name", () => {
    writeUserConfig(cfgWith(["a", "b"]));
    const { config } = loadConfig();
    expect(() => selectHostName("nope", config)).toThrow(/Unknown host/);
  });

  it("honours $PIROUETTE_SELECTED_HOST when no explicit name", () => {
    writeUserConfig(cfgWith(["a", "b"]));
    const { config } = loadConfig();
    process.env.PIROUETTE_SELECTED_HOST = "a";
    expect(selectHostName(undefined, config)).toBe("a");
  });

  it("falls back to default_host", () => {
    writeUserConfig(cfgWith(["a", "b"], "b"));
    const { config } = loadConfig();
    expect(selectHostName(undefined, config)).toBe("b");
  });

  it("falls back to the sole host when only one is defined", () => {
    writeUserConfig(cfgWith(["only"]));
    const { config } = loadConfig();
    expect(selectHostName(undefined, config)).toBe("only");
  });

  it("throws when multiple hosts and no selection", () => {
    writeUserConfig(cfgWith(["a", "b"]));
    const { config } = loadConfig();
    expect(() => selectHostName(undefined, config)).toThrow(/--host/);
  });

  it("throws when no hosts are configured", () => {
    writeUserConfig(`[defaults]\nnpm_package = "@scope/pkg@latest"\n`);
    const { config } = loadConfig();
    expect(listHostNames(config)).toEqual([]);
    expect(() => selectHostName(undefined, config)).toThrow(/No hosts configured/);
  });

  it("explicit name beats default_host and env", () => {
    writeUserConfig(cfgWith(["a", "b"], "a"));
    const { config } = loadConfig();
    process.env.PIROUETTE_SELECTED_HOST = "b";
    expect(selectHostName("a", config)).toBe("a");
  });
});
