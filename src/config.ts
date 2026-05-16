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
  /** Which host-provider implementation to use. Absent `[provider]` table
   *  reads as "ec2" — the AWS+Docker path (`pru setup` provisions an EC2
   *  instance, mounts an EBS data volume, runs the container). "byo-host"
   *  targets an existing SSH-reachable Linux host (a METR devpod, a
   *  long-running personal VM, etc.) with a persistent volume mounted
   *  somewhere; pirouette uploads a bootstrap script over SSH.
   *  See docs/plans/2026-05-13-provider-abstraction.md. */
  provider: {
    kind: "ec2" | "byo-host";
    /** Settings consumed when `kind = "byo-host"`. Ignored otherwise.
     *  Key with bracket-quotes in TOML: `[provider.byo-host]`. */
    "byo-host": {
      /** Entry in `~/.ssh/config` the user already has (e.g. "gpu").
       *  Pirouette doesn't write anything to ssh_config for this
       *  provider; it just runs `ssh <alias>`. */
      ssh_alias: string;
      /** Where on the remote the persistent volume is mounted. Anything
       *  under this dir survives across pod/instance recreates. */
      persistent_root: string;
      /** SSH login user on the remote (also the user owning `$HOME`). */
      user: string;
      /** Override the persistent `$HOME` path. Default:
       *  `${persistent_root}/home/${user}`. The bootstrap symlinks
       *  `/home/${user}` -> this path. Empty = use default. */
      home_dir: string;
      /** Override `$PIROUETTE_DATA_DIR`. Default:
       *  `${persistent_root}/pirouette/data`. Server state lives here.
       *  Empty = use default. */
      data_dir: string;
      /** Tailscale integration. When enabled, the bootstrap installs
       *  tailscale (if missing), starts tailscaled in userspace mode,
       *  runs `tailscale up` (interactive on first boot — prints a
       *  login URL the user approves in a browser), and bridges the
       *  tailnet's :443 to the pirouette server's loopback bind via
       *  `tailscale serve`. Lets you reach the dashboard from any
       *  device on the tailnet (phone, other laptop, ...) without an
       *  SSH tunnel. Server binding stays 127.0.0.1; only tailscaled
       *  (same netns) reaches it. */
      tailscale: {
        /** Master switch. Default false. */
        enabled: boolean;
        /** Tailnet hostname for this device. Empty = derived from
         *  ssh_alias as `pirouette-${ssh_alias}`. The full FQDN you
         *  reach from your phone is `${hostname}.<your-tailnet>.ts.net`. */
        hostname: string;
        /** Symlink `/var/lib/tailscale` to
         *  `${persistent_root}/tailscale-state` so the node key + auth
         *  state survive pod recreate. Default true. Set false if you
         *  prefer fresh tailnet identity per pod. */
        state_persistent: boolean;
      };
    };
  };
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
  server: {
    /** Extra hostnames the server will accept in the HTTP `Host` header
     *  and the WS `Origin` header. Useful when reaching the dashboard via
     *  a tailnet hostname (`pirouette-neev`) or any non-loopback name.
     *  Each entry can be `<host>` (port appended automatically and the
     *  bare-host variant added too — covers TLS proxies on default ports)
     *  or `<host>:<port>` (explicit, added as-is). Default: empty — only
     *  loopback addresses accepted. */
    allowed_hosts: string[];
    /** Canonical URL where the dashboard lives — used by `pru open` to
     *  pick a browser target and by the CLI as the default API base.
     *  When set, the CLI talks to this directly (no SSH tunnel). When
     *  empty, you'll get a `pru open` error directing you to set this
     *  or the `PIROUETTE_URL` env var. Example:
     *    public_url = "https://pirouette-neev.<your-tailnet>.ts.net"
     */
    public_url: string;
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
  provider: {
    kind: "ec2",
    "byo-host": {
      ssh_alias: "",
      persistent_root: "",
      user: "",
      home_dir: "",
      data_dir: "",
      tailscale: {
        enabled: false,
        hostname: "",
        state_persistent: true,
      },
    },
  },
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
  server: {
    allowed_hosts: [],
    public_url: "",
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

/** Default location for the user override config when no explicit path is
 *  supplied. Kept as a separate constant so callers (state.ts in particular)
 *  can detect whether they're operating against the historical default
 *  layout vs a custom path. */
export function defaultUserConfigPath(): string {
  return path.join(homedir(), ".pirouette", "config.toml");
}

/** Resolve the active user-override config path. Resolution order:
 *    1. `$PIROUETTE_CONFIG` env var (set by the CLI's `--config` flag or
 *       by the caller directly).
 *    2. `~/.pirouette/config.toml` (the historical default).
 *
 *  The CLI's top-level `--config <path>` option sets the env var in a
 *  pre-action hook so subcommand handlers see the override through this
 *  function transparently. Same path resolution is used by the state-
 *  file location logic so multi-deployment setups stay self-contained
 *  (one TOML + one host.json per deployment, both in the same dir by
 *  default). */
export function userConfigPath(): string {
  const fromEnv = process.env.PIROUETTE_CONFIG;
  if (fromEnv && fromEnv.trim().length > 0) {
    return expandHome(fromEnv);
  }
  return defaultUserConfigPath();
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

/** Fields that are environment-specific and have no safe default. Each
 *  provider has its own required-fields list — the EC2 path needs AWS +
 *  container config; byo-host needs an SSH alias + persistent root.
 *  `pru setup` and related remote commands call `requireConfigured()`
 *  before touching the host; it errors with a pointer to the exact keys
 *  that need filling in. */
type RequiredField = {
  path: string;
  get: (c: PirouetteConfig) => string;
};

const EC2_REQUIRED_FIELDS: RequiredField[] = [
  { path: "aws.network.vpc_name", get: (c) => c.aws.network.vpc_name },
  { path: "aws.network.subnet_name_pattern", get: (c) => c.aws.network.subnet_name_pattern },
  { path: "aws.network.security_group_name", get: (c) => c.aws.network.security_group_name },
  { path: "aws.tags.Owner", get: (c) => c.aws.tags.Owner ?? "" },
  { path: "instance.key_name", get: (c) => c.instance.key_name },
  { path: "container.image", get: (c) => c.container.image },
  { path: "container.container_user", get: (c) => c.container.container_user },
  { path: "container.npm_package", get: (c) => c.container.npm_package },
];

const BYO_HOST_REQUIRED_FIELDS: RequiredField[] = [
  { path: "provider.byo-host.ssh_alias", get: (c) => c.provider["byo-host"]?.ssh_alias ?? "" },
  { path: "provider.byo-host.persistent_root", get: (c) => c.provider["byo-host"]?.persistent_root ?? "" },
  { path: "provider.byo-host.user", get: (c) => c.provider["byo-host"]?.user ?? "" },
  { path: "container.npm_package", get: (c) => c.container.npm_package },
];

function requiredFieldsFor(kind: PirouetteConfig["provider"]["kind"]): RequiredField[] {
  switch (kind) {
    case "ec2":
      return EC2_REQUIRED_FIELDS;
    case "byo-host":
      return BYO_HOST_REQUIRED_FIELDS;
    default: {
      // Exhaustiveness check so adding a new kind here errors at compile
      // time if its required-fields list is forgotten.
      const _exhaustive: never = kind;
      void _exhaustive;
      return [];
    }
  }
}

const EXAMPLE_EC2 = [
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

const EXAMPLE_BYO_HOST = [
  `[provider]`,
  `kind = "byo-host"`,
  ``,
  `[provider.byo-host]`,
  `ssh_alias       = "gpu"           # entry in ~/.ssh/config`,
  `persistent_root = "/data"         # mount-point of your persistent volume`,
  `user            = "your-username" # SSH login user`,
  `# home_dir = ""                   # optional: default "\${persistent_root}/home/\${user}"`,
  `# data_dir = ""                   # optional: default "\${persistent_root}/pirouette/data"`,
  ``,
  `[container]`,
  `npm_package = "@your-scope/pirouette@latest"`,
].join("\n");

/** Throw with a helpful message if required fields are empty. Used by remote
 *  commands (`pru setup`, etc.) before they touch the host. The error
 *  message lists the missing keys and an example block scoped to the
 *  current `provider.kind`. */
export function requireConfigured(config: PirouetteConfig = getConfig()): void {
  const kind = config.provider?.kind ?? "ec2";
  const fields = requiredFieldsFor(kind);
  const missing = fields
    .filter(({ get }) => !get(config) || get(config) === "UNSET")
    .map(({ path }) => path);
  if (missing.length === 0) return;

  const example = kind === "ec2" ? EXAMPLE_EC2 : EXAMPLE_BYO_HOST;

  throw new Error(
    `Missing required config values for provider.kind="${kind}":\n` +
      missing.map((k) => `  - ${k}`).join("\n") +
      `\n\nSet them in ${userConfigPath()}. Example:\n\n${example}\n`,
  );
}

/** Effective byo-host config with computed defaults applied for empty
 *  override fields. Only meaningful when `provider.kind === "byo-host"`. */
export interface EffectiveByoHostConfig {
  ssh_alias: string;
  persistent_root: string;
  user: string;
  home_dir: string;
  data_dir: string;
  tailscale: EffectiveByoHostTailscaleConfig;
}

export interface EffectiveByoHostTailscaleConfig {
  enabled: boolean;
  /** Resolved short hostname (e.g. "pirouette-gpu-devpod"). The full
   *  FQDN is `${hostname}.<tailnet>.ts.net` once tailscale is up. */
  hostname: string;
  state_persistent: boolean;
}

/** Resolve byo-host config with default home_dir/data_dir computed from
 *  persistent_root + user when not explicitly set. Throws if the
 *  required fields are missing (call `requireConfigured` first to get a
 *  better error message). */
export function resolveByoHostConfig(config: PirouetteConfig = getConfig()): EffectiveByoHostConfig {
  const b = config.provider["byo-host"];
  if (!b || !b.ssh_alias || !b.persistent_root || !b.user) {
    throw new Error(
      "byo-host provider not configured; set provider.byo-host.{ssh_alias, persistent_root, user}",
    );
  }
  const ts = b.tailscale ?? { enabled: false, hostname: "", state_persistent: true };
  return {
    ssh_alias: b.ssh_alias,
    persistent_root: b.persistent_root,
    user: b.user,
    home_dir: b.home_dir || `${b.persistent_root}/home/${b.user}`,
    data_dir: b.data_dir || `${b.persistent_root}/pirouette/data`,
    tailscale: {
      enabled: ts.enabled,
      // Default short hostname: `pirouette-<alias>` with non-alphanumerics
      // collapsed to single hyphens (tailnet hostnames are DNS labels:
      // letters/digits/hyphens only, <=63 chars). If the user supplied an
      // explicit hostname, trust it.
      hostname:
        ts.hostname ||
        `pirouette-${b.ssh_alias.replace(/[^a-zA-Z0-9-]+/g, "-")}`.slice(0, 63),
      state_persistent: ts.state_persistent !== false,
    },
  };
}
