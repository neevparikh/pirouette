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
import { buildBootstrapEnv } from "../cli/remote/host.js";

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

  it("resolves tailscale: default hostname, sanitization, truncation, override, defaults", () => {
    writeUserConfig(`
[defaults]
npm_package = "@scope/pkg@latest"

[hosts.plain]
ssh_alias = "gpu"
user = "u"
persistent_root = "/data"

[hosts.weird]
ssh_alias = "weird_alias.name"
user = "u"
persistent_root = "/data"

[hosts.weird.tailscale]
enabled = true

[hosts.override]
ssh_alias = "gpu"
user = "u"
persistent_root = "/data"

[hosts.override.tailscale]
enabled = true
hostname = "my-box"
state_persistent = false
`);
    const { config } = loadConfig();

    // default: disabled, derived hostname, state_persistent defaults true
    const plain = resolveHost("plain", config);
    expect(plain.tailscale.enabled).toBe(false);
    expect(plain.tailscale.hostname).toBe("pirouette-gpu");
    expect(plain.tailscale.state_persistent).toBe(true);

    // non-alphanumerics in ssh_alias collapse to single hyphens
    const weird = resolveHost("weird", config);
    expect(weird.tailscale.enabled).toBe(true);
    expect(weird.tailscale.hostname).toBe("pirouette-weird-alias-name");

    // explicit override + state_persistent=false respected
    const ov = resolveHost("override", config);
    expect(ov.tailscale.hostname).toBe("my-box");
    expect(ov.tailscale.state_persistent).toBe(false);
  });

  it("truncates a derived tailscale hostname to 63 chars", () => {
    const longAlias = "a".repeat(80);
    writeUserConfig(`
[defaults]
npm_package = "@scope/pkg@latest"

[hosts.h]
ssh_alias = "${longAlias}"
user = "u"
persistent_root = "/data"
`);
    const { config } = loadConfig();
    const h = resolveHost("h", config);
    expect(h.tailscale.hostname.length).toBe(63);
    expect(h.tailscale.hostname.startsWith("pirouette-")).toBe(true);
  });

  it("defaults and resolves public_url / allowed_hosts / bind_host", () => {
    writeUserConfig(`
[defaults]
npm_package = "@scope/pkg@latest"
bind_host = "0.0.0.0"

[hosts.inherits]
ssh_alias = "a"
user = "u"
persistent_root = "/data"

[hosts.explicit]
ssh_alias = "b"
user = "u"
persistent_root = "/data"
bind_host = "127.0.0.1"
public_url = "https://x.ts.net"
allowed_hosts = ["x", "x.ts.net"]
`);
    const { config } = loadConfig();
    const inh = resolveHost("inherits", config);
    expect(inh.bind_host).toBe("0.0.0.0"); // inherited from defaults
    expect(inh.public_url).toBe("");
    expect(inh.allowed_hosts).toEqual([]);
    const ex = resolveHost("explicit", config);
    expect(ex.bind_host).toBe("127.0.0.1"); // per-host override wins
    expect(ex.public_url).toBe("https://x.ts.net");
    expect(ex.allowed_hosts).toEqual(["x", "x.ts.net"]);
  });

  it("throws a distinct error when the host name isn't defined at all", () => {
    writeUserConfig(`
[defaults]
npm_package = "@scope/pkg@latest"

[hosts.a]
ssh_alias = "a"
user = "u"
persistent_root = "/data"
`);
    const { config } = loadConfig();
    expect(() => resolveHost("ghost", config)).toThrow(/not defined/);
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

  it("throws on an unknown host supplied via env", () => {
    writeUserConfig(cfgWith(["a", "b"]));
    const { config } = loadConfig();
    process.env.PIROUETTE_SELECTED_HOST = "ghost";
    expect(() => selectHostName(undefined, config)).toThrow(/Unknown host/);
  });

  it("throws on an unknown default_host", () => {
    writeUserConfig(cfgWith(["a", "b"], "ghost"));
    const { config } = loadConfig();
    expect(() => selectHostName(undefined, config)).toThrow(/Unknown host/);
  });
});

describe("buildBootstrapEnv", () => {
  function resolve(body: string, name: string) {
    writeUserConfig(body);
    return resolveHost(name, loadConfig().config);
  }

  it("omits empty/false-y optionals and stringifies flags", () => {
    const h = resolve(`
[defaults]
npm_package = "@scope/pkg@latest"

[hosts.min]
ssh_alias = "a"
user = "u"
persistent_root = "/data"
`, "min");
    const env = buildBootstrapEnv(h);
    expect(env.PIROUETTE_PERSISTENT_ROOT).toBe("/data");
    expect(env.PIROUETTE_HOME_DIR).toBe("/data/home/u");
    expect(env.PIROUETTE_DATA_DIR).toBe("/data/pirouette/data");
    expect(env.PIROUETTE_PACKAGE).toBe("@scope/pkg@latest");
    expect(env.PIROUETTE_PORT).toBe("7777");
    expect(env.PIROUETTE_BIND_HOST).toBe("127.0.0.1");
    // unset optionals omitted entirely
    expect(env.PIROUETTE_ADOPT).toBeUndefined();
    expect(env.PIROUETTE_DOTFILES_URL).toBeUndefined();
    expect(env.PIROUETTE_DEFAULT_MODEL).toBeUndefined();
    expect(env.PIROUETTE_ALLOWED_HOSTS).toBeUndefined();
    expect(env.PIROUETTE_TS_ENABLED).toBeUndefined();
  });

  it("maps adopt, dotfiles, model, allowed_hosts join, and tailscale", () => {
    const h = resolve(`
[defaults]
npm_package = "@scope/pkg@latest"
default_model = "m/x"
default_thinking_level = "low"

[defaults.dotfiles]
clone_url = "git@h:me/df.git"
authorized_keys_url = "https://h/keys"

[hosts.full]
ssh_alias = "a"
user = "u"
persistent_root = "/data"
adopt = true
allowed_hosts = ["h1", "h2"]

[hosts.full.tailscale]
enabled = true
hostname = "ts-box"
state_persistent = false
`, "full");
    const env = buildBootstrapEnv(h);
    expect(env.PIROUETTE_ADOPT).toBe("1");
    expect(env.PIROUETTE_DOTFILES_URL).toBe("git@h:me/df.git");
    expect(env.PIROUETTE_AUTHORIZED_KEYS_URL).toBe("https://h/keys");
    expect(env.PIROUETTE_DEFAULT_MODEL).toBe("m/x");
    expect(env.PIROUETTE_DEFAULT_THINKING_LEVEL).toBe("low");
    expect(env.PIROUETTE_ALLOWED_HOSTS).toBe("h1,h2");
    expect(env.PIROUETTE_TS_ENABLED).toBe("1");
    expect(env.PIROUETTE_TS_HOSTNAME).toBe("ts-box");
    expect(env.PIROUETTE_TS_STATE_PERSISTENT).toBe("0");
  });
});
