/** Pirouette config loader.
 *
 *  Layering (later wins):
 *    built-in defaults  <  ./pirouette.toml  <  ~/.pirouette/config.toml  <  CLI flags
 *
 *  Use `getConfig()` to read the merged effective config once per CLI invocation.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml } from "smol-toml";

export interface PirouetteConfig {
  aws: {
    profile: string;
    region: string;
    network: {
      vpc_name: string;
      subnet_name_pattern: string;
      security_group_name: string;
    };
    tags: Record<string, string>;
  };
  instance: {
    type: string;
    ami_name_pattern: string;
    ami_owner: string;
    key_name: string;
  };
  ebs: {
    size_gb: number;
    type: string;
    volume_name: string;
  };
  ssh: {
    user: string;
    private_key: string;
    public_key_path: string;
    host_alias: string;
  };
  container: {
    image: string;
    container_user: string;
    container_home: string;
    pirouette_port: number;
    /** npm package spec the container's entrypoint installs globally
     *  (e.g. `@your-scope/pirouette@latest`). Must be non-empty. */
    npm_package: string;
    /** Default model string used when `pru launch` doesn't pass `--model`.
     *  Set to something your credentials can actually talk to, e.g.
     *  `anthropic/claude-sonnet-4-5` or `hawk/claude-opus-4-7`. */
    default_model: string;
    /** Default thinking level for new agents when none is specified
     *  (e.g. @<newname> quick-creates from the web UI). Empty = "off".
     *  Values: off | minimal | low | medium | high. */
    default_thinking_level: string;
    /** Optional path to a custom entrypoint script. When set, this file is
     *  uploaded to the host instead of pirouette's bundled
     *  `scripts/pirouette-entrypoint.sh`. Use this when you want to swap
     *  yadm for chezmoi/stow/vcsh, change how the npm package is installed,
     *  add pre-server hooks, etc. The script must:
     *    - run as the container's non-root user (uid 1000 by default)
     *    - read PIROUETTE_PACKAGE / PIROUETTE_DATA_DIR / PIROUETTE_PORT etc.
     *    - leave the container alive (e.g. `exec sleep infinity` at the end)
     *  Path may be `~`-prefixed; resolved relative to laptop. Empty = use
     *  bundled default. */
    entrypoint_script: string;
  };
  dotfiles: {
    /** Public HTTPS URL to `yadm clone` on first container boot. Empty → skip. */
    clone_url: string;
    /** URL that returns an `authorized_keys`-formatted body (e.g. GitHub's
     *  `/<user>.keys`). Empty → skip; container sshd will have no authorized
     *  users. */
    authorized_keys_url: string;
  };
}

/** Built-in fallback values. These are last-resort defaults for anything not
 *  specified in the TOML files. pirouette.toml at the repo root is the real
 *  source of truth — this is only in case the TOML is missing for some
 *  reason (e.g. `npm pack` misconfiguration).
 *
 *  Deliberately empty for values that tie the tool to a specific AWS
 *  environment — those must come from `~/.pirouette/config.toml`. */
const BUILTIN_DEFAULTS: PirouetteConfig = {
  aws: {
    profile: "default",
    region: "us-west-2",
    network: { vpc_name: "", subnet_name_pattern: "", security_group_name: "" },
    tags: { Owner: "" },
  },
  instance: {
    type: "m6i.16xlarge",
    ami_name_pattern: "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*",
    ami_owner: "099720109477",
    key_name: "",
  },
  ebs: {
    size_gb: 500,
    type: "gp3",
    volume_name: "pirouette-data",
  },
  ssh: {
    user: "ubuntu",
    private_key: "~/.ssh/id_ed25519",
    public_key_path: "~/.ssh/id_ed25519.pub",
    host_alias: "pirouette",
  },
  container: {
    image: "",
    container_user: "",
    container_home: "",
    entrypoint_script: "",
    pirouette_port: 7777,
    npm_package: "",
    default_model: "",
    default_thinking_level: "",
  },
  dotfiles: {
    clone_url: "",
    authorized_keys_url: "",
  },
};

export interface ConfigSource {
  path: string;
  exists: boolean;
  data: Partial<PirouetteConfig>;
}

/** Find the repo/package's pirouette.toml by walking up from this source file.
 *  Works in both dev (src/config.ts) and built (dist/config.js) layouts — one
 *  level up from either reaches the package root. */
function repoConfigPath(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "pirouette.toml");
}

function userConfigPath(): string {
  return path.join(homedir(), ".pirouette", "config.toml");
}

function loadTomlIfExists(p: string): ConfigSource {
  try {
    const raw = readFileSync(p, "utf8");
    return { path: p, exists: true, data: parseToml(raw) as Partial<PirouetteConfig> };
  } catch {
    return { path: p, exists: false, data: {} };
  }
}

/** Deep-merge `b` on top of `a`, returning a new object. Plain objects merge
 *  recursively; everything else replaces. Arrays replace (we don't need array
 *  merging for this config). */
function deepMerge<T>(a: T, b: Partial<T>): T {
  if (a === null || a === undefined) return b as T;
  if (b === null || b === undefined) return a;
  if (typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) {
    return b as T;
  }
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = deepMerge(
      (a as Record<string, unknown>)[k],
      v as Partial<unknown>,
    );
  }
  return out as T;
}

/** Expand ~ at the start of a path to the user's home directory. */
export function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

export interface LoadedConfig {
  config: PirouetteConfig;
  sources: ConfigSource[];
}

/** Load and merge all config sources. Does not validate that required fields
 *  (Owner, key_name) are set — callers should call `requireConfigured(config)`
 *  before using the config for an operation that creates AWS resources. */
export function loadConfig(): LoadedConfig {
  const sources: ConfigSource[] = [
    loadTomlIfExists(repoConfigPath()),
    loadTomlIfExists(userConfigPath()),
  ];

  let config: PirouetteConfig = BUILTIN_DEFAULTS;
  for (const s of sources) {
    if (s.exists) config = deepMerge(config, s.data);
  }
  return { config, sources };
}

/** Cached singleton. `loadConfig()` is deterministic and cheap, but callers
 *  shouldn't reload per access. */
let cached: LoadedConfig | null = null;
export function getConfig(): PirouetteConfig {
  if (!cached) cached = loadConfig();
  return cached.config;
}

export function getConfigSources(): ConfigSource[] {
  if (!cached) cached = loadConfig();
  return cached.sources;
}

/** Reset cached config (used by tests). */
export function resetConfigCache(): void {
  cached = null;
}

/** Container home path, derived from `container_user` if not explicitly set.
 *  Convention: Linux users have homes at /home/<user>. Override
 *  `container.container_home` if your image does something else. */
export function containerHome(config: PirouetteConfig = getConfig()): string {
  return config.container.container_home || `/home/${config.container.container_user}`;
}

/** Fields that are environment-specific and have no safe default. `pru setup`
 *  and related remote commands call `requireConfigured()` before touching AWS;
 *  it errors with a pointer to the exact keys that need filling in. */
const REQUIRED_FIELDS: Array<{
  path: string;
  get: (c: PirouetteConfig) => string;
}> = [
  { path: "aws.network.vpc_name", get: (c) => c.aws.network.vpc_name },
  { path: "aws.network.subnet_name_pattern", get: (c) => c.aws.network.subnet_name_pattern },
  { path: "aws.network.security_group_name", get: (c) => c.aws.network.security_group_name },
  { path: "aws.tags.Owner", get: (c) => c.aws.tags.Owner ?? "" },
  { path: "instance.key_name", get: (c) => c.instance.key_name },
  { path: "container.image", get: (c) => c.container.image },
  { path: "container.container_user", get: (c) => c.container.container_user },
  { path: "container.npm_package", get: (c) => c.container.npm_package },
];

/** Throw with a helpful message if required fields are empty. Used by remote
 *  commands (`pru setup`, etc.) that actually hit AWS. */
export function requireConfigured(config: PirouetteConfig = getConfig()): void {
  const missing = REQUIRED_FIELDS.filter(
    ({ get }) => !get(config) || get(config) === "UNSET",
  ).map(({ path }) => path);
  if (missing.length === 0) return;

  const example = [
    `[aws]`,
    `profile = "your-aws-profile"`,
    `region  = "us-west-2"`,
    ``,
    `[aws.network]`,
    `vpc_name            = "your-vpc"`,
    `subnet_name_pattern = "your-private-subnet-*"`,
    `security_group_name = "your-dev-sg"`,
    ``,
    `[aws.tags]`,
    `Owner = "you@example.com"`,
    ``,
    `[instance]`,
    `key_name = "your-ec2-keypair-name"`,
    ``,
    `[container]`,
    `image          = "your-dev-container:latest"`,
    `container_user = "you"                # non-root user inside the image`,
    `npm_package    = "@your-scope/pirouette@latest"`,
  ].join("\n");

  throw new Error(
    `Missing required config values:\n` +
      missing.map((k) => `  - ${k}`).join("\n") +
      `\n\nSet them in ${userConfigPath()}. Example:\n\n${example}\n`,
  );
}
