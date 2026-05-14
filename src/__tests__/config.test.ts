/** Tests for provider-aware config loading + requireConfigured.
 *
 *  Focus: the matrix where provider.kind ∈ {ec2, byo-host} and required
 *  fields differ per kind. Regression-protects against the Phase 1 → 2
 *  transition silently re-introducing AWS-key requirements for byo-host
 *  setups (or vice-versa).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadConfig,
  requireConfigured,
  resetConfigCache,
  resolveByoHostConfig,
} from "../config.js";

let sandbox: string;
let prevHome: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "pir-config-test-"));
  prevHome = process.env.HOME;
  process.env.HOME = sandbox;
  resetConfigCache();
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(sandbox, { recursive: true, force: true });
  resetConfigCache();
});

function writeUserConfig(body: string): void {
  const dir = path.join(sandbox, ".pirouette");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.toml"), body);
}

describe("requireConfigured — ec2 (default)", () => {
  it("throws with EC2-shaped example when no provider table is set", () => {
    writeUserConfig(`
[aws.tags]
Owner = "you@example.com"
`);
    const { config } = loadConfig();
    expect(() => requireConfigured(config)).toThrow(/provider\.kind="ec2"/);
    expect(() => requireConfigured(config)).toThrow(/aws\.network\.vpc_name/);
    expect(() => requireConfigured(config)).toThrow(/instance\.key_name/);
  });

  it("passes when all EC2 fields are filled", () => {
    writeUserConfig(`
[aws.network]
vpc_name = "v"
subnet_name_pattern = "s-*"
security_group_name = "sg"

[aws.tags]
Owner = "you@example.com"

[instance]
key_name = "kp"

[container]
image = "img"
container_user = "user"
npm_package = "@scope/pkg@latest"
`);
    const { config } = loadConfig();
    expect(() => requireConfigured(config)).not.toThrow();
  });
});

describe("requireConfigured — byo-host", () => {
  it("does NOT require AWS keys when kind = byo-host", () => {
    writeUserConfig(`
[provider]
kind = "byo-host"

[provider.byo-host]
ssh_alias = "gpu"
persistent_root = "/data"
user = "neev"

[container]
npm_package = "@scope/pkg@latest"
`);
    const { config } = loadConfig();
    expect(() => requireConfigured(config)).not.toThrow();
  });

  it("requires the byo-host quartet", () => {
    writeUserConfig(`
[provider]
kind = "byo-host"

[provider.byo-host]
ssh_alias = "gpu"
# missing persistent_root + user

[container]
npm_package = "@scope/pkg@latest"
`);
    const { config } = loadConfig();
    expect(() => requireConfigured(config)).toThrow(/byo-host/);
    expect(() => requireConfigured(config)).toThrow(/persistent_root/);
    expect(() => requireConfigured(config)).toThrow(/\.user/);
  });

  // Note: we'd like to assert that container.npm_package is required
  // when missing from user config, but the repo's pirouette.toml always
  // ships a non-empty default ("@neevparikh/pirouette@latest"), so in
  // practice the field is never empty in a checkout-driven test.
  // EC2's "passes when all fields are filled" test (above) and the
  // BYO host's "requires the byo-host quartet" test together cover the
  // required-fields-list machinery.
});

describe("resolveByoHostConfig — defaults", () => {
  it("computes home_dir and data_dir from persistent_root + user", () => {
    writeUserConfig(`
[provider]
kind = "byo-host"

[provider.byo-host]
ssh_alias = "gpu"
persistent_root = "/data"
user = "neev"
`);
    const { config } = loadConfig();
    const resolved = resolveByoHostConfig(config);
    expect(resolved.home_dir).toBe("/data/home/neev");
    expect(resolved.data_dir).toBe("/data/pirouette/data");
    expect(resolved.ssh_alias).toBe("gpu");
  });

  it("respects explicit home_dir / data_dir overrides", () => {
    writeUserConfig(`
[provider]
kind = "byo-host"

[provider.byo-host]
ssh_alias = "gpu"
persistent_root = "/data"
user = "neev"
home_dir = "/elsewhere/home"
data_dir = "/elsewhere/pirouette/state"
`);
    const { config } = loadConfig();
    const resolved = resolveByoHostConfig(config);
    expect(resolved.home_dir).toBe("/elsewhere/home");
    expect(resolved.data_dir).toBe("/elsewhere/pirouette/state");
  });

  it("throws when byo-host required fields are missing", () => {
    writeUserConfig(`
[provider]
kind = "byo-host"

[provider.byo-host]
ssh_alias = ""
persistent_root = ""
user = ""
`);
    const { config } = loadConfig();
    expect(() => resolveByoHostConfig(config)).toThrow();
  });
});
